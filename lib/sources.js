"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SOURCE_KINDS } = require("./agents.js");

const MAX_DEPTH = 6;
const MAX_ENTRIES = 20000;
const BEST_EFFORT_EXTENSIONS = new Set([".jsonl", ".json", ".md", ".log"]);

class SourceContextUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SourceContextUnavailable";
    this.reason = reason;
  }
}

const join = (...parts) => path.join(...parts);

// roots(homedir, env) -> candidate directories, first existing one wins.
// fileMatch(basename, id) -> true when the file is this session's transcript.
// dirMatch(basename, id)  -> true when the directory belongs to this session.
// dirFile(basename)       -> true for the transcript inside a matched directory.
const STORES = {
  claude: {
    strategy: "file",
    verified: true,
    roots: (home, env) => [
      env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "projects") : null,
      join(home, ".claude", "projects"),
    ],
    fileMatch: (base, id) => base === `${id}.jsonl`,
    recover: recoverClaude,
  },
  codex: {
    strategy: "file",
    verified: true,
    roots: (home, env) => [
      env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : null,
      join(home, ".codex", "sessions"),
    ],
    fileMatch: (base, id) => base.startsWith("rollout-") && base.endsWith(`-${id}.jsonl`),
    recover: recoverCodex,
  },
  pi: {
    strategy: "file",
    verified: true,
    roots: (home) => [join(home, ".pi", "agent", "sessions")],
    fileMatch: (base, id) => base.endsWith(`_${id}.jsonl`),
    recover: recoverPi,
  },
  opencode: {
    strategy: "sqlite",
    verified: true,
    dbPaths: (home, env) => [
      env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "opencode", "opencode.db") : null,
      join(home, ".local", "share", "opencode", "opencode.db"),
      join(home, "Library", "Application Support", "opencode", "opencode.db"),
    ],
    recover: recoverOpencode,
  },
  omp: { strategy: "file", roots: (home) => [join(home, ".omp", "agent", "sessions")] },
  copilot: { strategy: "file", roots: (home) => [join(home, ".copilot")] },
  devin: { strategy: "file", roots: (home) => [join(home, ".devin")] },
  droid: { strategy: "file", roots: (home) => [join(home, ".factory")] },
  kimi: { strategy: "file", roots: (home) => [join(home, ".kimi-code")] },
  qodercli: { strategy: "file", roots: (home) => [join(home, ".qoder")] },
  kilo: { strategy: "file", roots: (home) => [join(home, ".config", "kilo")] },
  cursor: { strategy: "file", roots: (home) => [join(home, ".cursor")] },
  mastracode: {
    strategy: "file",
    roots: (home) => [join(home, ".mastracode"), join(home, ".mastra")],
  },
  hermes: { strategy: "file", roots: (home) => [join(home, ".hermes", "sessions")] },
  agy: {
    strategy: "file",
    verified: true,
    roots: (home, env) => [
      env.ANTIGRAVITY_HOME ? join(env.ANTIGRAVITY_HOME, "brain") : null,
      join(home, ".gemini", "antigravity-cli", "brain"),
      join(home, ".antigravity", "sessions"),
    ],
    fileMatch: (base, id) => base.includes(id) && (base.endsWith(".jsonl") || base.endsWith(".json")),
  },
  // cline and grok are not in SOURCE_KINDS: Herdr's is_official_agent_source()
  // reports no agent_session for them. Both are recovered from their own stores
  // below, keyed by the pane's working directory. They are never *guessed*: a
  // store with no unique cwd match fails closed exactly like a missing reference.
  cline: {
    strategy: "file",
    verified: false,
    roots: (home, env) => [join(env.CLINE_DATA_DIR || join(home, ".cline", "data"), "sessions")],
    recover: recoverCline,
    noRecord: (cwd) =>
      `cline has no persisted session for ${cwd} yet; cline writes its transcript after the first exchange`,
  },
  grok: {
    strategy: "file",
    verified: false,
    roots: (home, env) => [join(env.GROK_DATA_DIR || join(home, ".grok"), "sessions")],
    recover: recoverGrok,
    noRecord: (cwd) => `grok has no indexed session for ${cwd} yet`,
  },
};

// ---------------------------------------------------------------------------
// Recovery: resolving the pane's session from the agent's own store when the
// native reference is missing or points at nothing.
//
// Every recover* function has the same contract: return a resolved descriptor,
// throw SourceContextUnavailable when the store proves there is no safe answer
// (ambiguity, missing transcript), or return null when the store has no record
// for this cwd at all (so the caller reports the original failure).
// ---------------------------------------------------------------------------

const sameCwd = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => path.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
};

function readFirstLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const i = text.indexOf("\n");
    return i === -1 ? text : text.slice(0, i);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionJsonlFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(dir, e.name));
}

// Mirrors pi's own session-directory encoding
// (dist/core/session-manager.js getDefaultSessionDirPath): strip a leading
// separator, replace / \ and : with -, wrap in --.
function piDirName(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// Mirrors Claude Code's project-directory encoding: separators, drive colon
// and spaces become dashes (observed: C:\Users\sanir\Herdr Plugin ->
// C--Users-sanir-Herdr-plugin).
function claudeDirName(cwd) {
  return cwd.replace(/[\\: ]/g, "-");
}

function uniqueDir(root, want) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.toLowerCase() === want.toLowerCase())
    .map((e) => join(root, e.name));
  return dirs.length === 1 ? dirs[0] : null;
}

function recoverPi(homedir, cwd, env) {
  const root = env.PI_SESSIONS_DIR || join(homedir, ".pi", "agent", "sessions");
  const dir = uniqueDir(root, piDirName(cwd));
  if (!dir) return null;
  const files = sessionJsonlFiles(dir);
  if (files.length === 0) {
    throw new SourceContextUnavailable(
      `pi has no transcript file for ${cwd} yet; pi writes it after the first assistant reply`
    );
  }
  if (files.length > 1) {
    throw new SourceContextUnavailable(
      `more than one pi session file for ${cwd}; refusing to guess which is active`
    );
  }
  return describeFile(files[0]);
}

function recoverClaude(homedir, cwd, env) {
  const root = env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, "projects")
    : join(homedir, ".claude", "projects");
  const dir = uniqueDir(root, claudeDirName(cwd));
  if (!dir) return null;
  const files = sessionJsonlFiles(dir);
  if (files.length === 0) return null;
  if (files.length > 1) {
    throw new SourceContextUnavailable(
      `more than one claude session for ${cwd}; refusing to guess which is active`
    );
  }
  return describeFile(files[0]);
}

function recoverCodex(homedir, cwd, env) {
  const root = env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : join(homedir, ".codex", "sessions");
  if (!fs.existsSync(root)) return null;
  // Codex keeps no cwd-keyed directory; each rollout's first line carries the
  // session_meta payload with its cwd. Scan bounded by the same budget as the
  // primary search, and only ever pick a unique newest match.
  const found = [];
  let budget = MAX_ENTRIES;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      let meta;
      try {
        meta = JSON.parse(readFirstLine(full)).payload;
      } catch {
        continue;
      }
      if (!meta || !sameCwd(meta.cwd, cwd)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size === 0) continue;
      found.push({ file: full, mtime: stat.mtimeMs });
    }
  };
  walk(root, 0);
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  if (found.length > 1 && found[1].mtime === found[0].mtime) {
    throw new SourceContextUnavailable(
      "more than one codex session for the same cwd is equally recent; refusing to guess"
    );
  }
  return describeFile(found[0].file);
}

// Cline's Herdr integration never reports a session reference, so every cline
// handoff comes through here. The authoritative record is sessions.db, which
// cline writes at launch (cwd, workspace_root, started_at) and closes out at
// exit (ended_at). A running cline therefore has exactly one open row per cwd.
function sqliteSnapshot(dbPath, workDir) {
  const copy = join(workDir, "handoff-snapshot.db");
  fs.mkdirSync(workDir, { recursive: true });
  fs.copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, copy + suffix);
  }
  return copy;
}

// Query a SQLite database owned by another agent. A live WAL database can
// refuse a read-only open mid-write, so fall back to a snapshot copy of the
// database plus its sidecars in a private temp dir. Returns null when the
// database cannot be read at all (or node:sqlite is unavailable), so callers
// degrade to their next evidence source instead of failing the handoff.
function querySqlite(dbPath, sql, params = []) {
  const { hasSqlite } = require("./source-sqlite.js");
  if (!hasSqlite() || !fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = require("node:sqlite");
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  } catch {
    const workDir = fs.mkdtempSync(join(os.tmpdir(), "agent-handoff-sqlite-"));
    try {
      const copy = sqliteSnapshot(dbPath, workDir);
      const db = new DatabaseSync(copy);
      try {
        return db.prepare(sql).all(...params);
      } finally {
        db.close();
      }
    } catch {
      return null;
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

// opencode keeps every session in one database; the session table records the
// working directory it ran in and bumps time_updated on every exchange. Herdr
// does not always report the opencode session id, so recovery picks the newest
// unarchived top-level session for the pane's cwd. time_updated is an explicit
// last-activity column, not a file mtime, so the newest row *is* the active
// session; equal timestamps still refuse to guess.
function recoverOpencode(homedir, cwd, env) {
  const dbPath = firstExisting(STORES.opencode.dbPaths(homedir, env));
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const rows = querySqlite(
    dbPath,
    "SELECT id, directory, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL"
  );
  if (!rows || rows.length === 0) return null;
  const matches = rows
    .filter((r) => typeof r.directory === "string" && sameCwd(r.directory, cwd))
    .sort((a, b) => b.time_updated - a.time_updated);
  if (matches.length === 0) return null;
  if (matches.length > 1 && matches[1].time_updated === matches[0].time_updated) {
    throw new SourceContextUnavailable(
      "more than one opencode session for the same cwd is equally recent; refusing to guess"
    );
  }
  return { strategy: "sqlite", dbPath, sessionId: matches[0].id };
}

function queryClineSessions(homedir, cwd, env) {
  const dataDir = env.CLINE_DATA_DIR || join(homedir, ".cline", "data");
  const dbPath = join(dataDir, "db", "sessions.db");
  if (!fs.existsSync(dbPath)) return null;
  const rows = querySqlite(
    dbPath,
    "SELECT session_id, started_at, ended_at FROM sessions WHERE workspace_root = ? OR cwd = ?",
    [cwd, cwd]
  );
  if (!rows) return null;
  const out = [];
  for (const row of rows) {
    if (!row.session_id) continue;
    const started = Date.parse(row.started_at) || 0;
    const ended = row.ended_at ? Date.parse(row.ended_at) : null;
    out.push({ id: row.session_id, started, ended });
  }
  return out;
}

function recoverCline(homedir, cwd, env) {
  let rows = queryClineSessions(homedir, cwd, env);
  // The per-session metadata files are a fallback for hosts without node:sqlite.
  if (!rows) {
    const sessionsRoot = join(env.CLINE_DATA_DIR || join(homedir, ".cline", "data"), "sessions");
    let entries;
    try {
      entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(join(sessionsRoot, id, `${id}.json`), "utf8"));
      } catch {
        continue;
      }
      const metaCwd = meta.workspace_root || meta.cwd;
      if (!metaCwd || !sameCwd(metaCwd, cwd)) continue;
      rows.push({
        id,
        started: Date.parse(meta.started_at) || 0,
        ended: meta.ended_at ? Date.parse(meta.ended_at) : null,
      });
    }
  }
  if (!rows || rows.length === 0) return null;
  // An open (running) row is the pane's session; only fall back to closed rows
  // when nothing is open for this cwd.
  const pool = rows.filter((r) => r.ended === null);
  const candidates = pool.length > 0 ? pool : rows;
  candidates.sort((a, b) => b.started - a.started);
  if (candidates.length > 1 && candidates[1].started === candidates[0].started) {
    throw new SourceContextUnavailable(
      "more than one cline session for the same cwd is equally new; refusing to guess"
    );
  }
  const best = candidates[0];
  const sessionsRoot = join(env.CLINE_DATA_DIR || join(homedir, ".cline", "data"), "sessions");
  const messages = join(sessionsRoot, best.id, `${best.id}.messages.json`);
  if (!fs.existsSync(messages)) {
    throw new SourceContextUnavailable(`cline session ${best.id} has no transcript file yet`);
  }
  return describeFile(messages);
}

// Grok's per-session search index records cwd and the session body. The pane's
// cwd is matched case-insensitively against the distinct stored values (grok
// stores both "Herdr plugin" and "Herdr Plugin" on this machine).
function recoverGrok(homedir, cwd, env) {
  const root = env.GROK_DATA_DIR || join(homedir, ".grok");
  const dbPath = join(root, "sessions", "session_search.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const { hasSqlite } = require("./source-sqlite.js");
  if (!hasSqlite()) {
    throw new SourceContextUnavailable("reading grok's session store requires Node 22.5 or newer");
  }
  const { DatabaseSync } = require("node:sqlite");
  let best = null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stored = db
      .prepare("SELECT cwd, MAX(updated_at) AS newest FROM session_docs GROUP BY cwd")
      .all()
      .filter((r) => typeof r.cwd === "string" && sameCwd(r.cwd, cwd))
      .sort((a, b) => b.newest - a.newest);
    if (stored.length === 0) return null;
    if (stored.length > 1 && stored[1].newest === stored[0].newest) {
      throw new SourceContextUnavailable(
        "more than one grok session for the same cwd is equally recent; refusing to guess"
      );
    }
    const rows = db
      .prepare("SELECT session_id, updated_at, content FROM session_docs WHERE cwd = ? ORDER BY updated_at DESC")
      .all(stored[0].cwd);
      if (rows.length === 0) return null;
      best = rows[0];
      if (rows.length > 1 && rows[1].updated_at === rows[0].updated_at) {
        throw new SourceContextUnavailable(
          "more than one grok session for the same cwd is equally recent; refusing to guess"
        );
      }
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof SourceContextUnavailable) throw err;
    return null;
  }
  const body = Buffer.from(String(best.content || ""), "utf8");
  if (body.length === 0) {
    throw new SourceContextUnavailable("grok has not indexed this session yet");
  }
  return {
    strategy: "sqlite-content",
    sessionId: best.session_id,
    dbPath,
    body,
    bytes: body.length,
    lines: countLines(body),
  };
}

function resolveAgyFallback(homedir, env, id) {
  const root = firstExisting(STORES.agy.roots(homedir, env));
  if (!root || !fs.existsSync(root)) return null;
  if (id) {
    const candidate = join(root, id, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(candidate)) return candidate;
    const direct = join(root, id, "transcript.jsonl");
    if (fs.existsSync(direct)) return direct;
  }
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sysLog = join(root, entry.name, ".system_generated", "logs", "transcript.jsonl");
      const directLog = join(root, entry.name, "transcript.jsonl");
      const target = fs.existsSync(sysLog) ? sysLog : fs.existsSync(directLog) ? directLog : null;
      if (target) {
        try {
          const stat = fs.statSync(target);
          if (stat.size > 0) candidates.push({ file: target, mtime: stat.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.length > 0 ? candidates[0].file : null;
  } catch {
    return null;
  }
}

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  if (buffer[buffer.length - 1] !== 0x0a) count += 1;
  return count;
}

function describeFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new SourceContextUnavailable(`session file does not exist: ${file}`);
  }
  if (!stat.isFile()) throw new SourceContextUnavailable(`session path is not a file: ${file}`);
  if (stat.size === 0) throw new SourceContextUnavailable(`session file is empty: ${file}`);
  const lines = countLines(fs.readFileSync(file));
  if (lines < 1) throw new SourceContextUnavailable(`session file has no lines: ${file}`);
  return { strategy: "file", path: file, bytes: stat.size, lines };
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function search(root, store, id) {
  const matches = [];
  let budget = MAX_ENTRIES;
  const bestEffort = store.verified !== true;

  const fileMatches = (base) => {
    if (store.fileMatch) return store.fileMatch(base, id);
    if (!bestEffort) return false;
    return base.includes(id) && BEST_EFFORT_EXTENSIONS.has(path.extname(base).toLowerCase());
  };

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (store.dirMatch && store.dirMatch(entry.name, id)) {
          let inner;
          try {
            inner = fs.readdirSync(full, { withFileTypes: true });
          } catch {
            continue;
          }
          const picked = inner.filter(
            (e) => e.isFile() && (store.dirFile ? store.dirFile(e.name)
              : BEST_EFFORT_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
          );
          for (const p of picked) matches.push(path.join(full, p.name));
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile() && fileMatches(entry.name)) {
        matches.push(full);
      }
    }
  };

  walk(root, 0);
  return matches;
}

// Failures that mean "the session's own record is not there (yet)" — worth
// retrying and worth recovering from. An ambiguity is the opposite: evidence
// exists but is inconclusive, and guessing is exactly what this feature forbids.
function recoverableFailure(err) {
  return /does not exist|no session file|is empty|has no lines|store directory not found/.test(
    err.reason || ""
  );
}

function resolve({ agent, sessionRef, env = process.env, homedir = os.homedir(), cwd = null }) {
  const store = STORES[agent];
  if (!store) {
    // A source-kind without a store (copilot, devin, hermes, …) still reports
    // a session id to Herdr; the honest failure is that no store is configured,
    // not that the agent reported nothing.
    throw new SourceContextUnavailable(
      SOURCE_KINDS.has(agent)
        ? `no session store is configured for ${agent}, so its transcript cannot be located`
        : `${agent} reports no session identity to Herdr, so it cannot be a handoff source`
    );
  }

  if (sessionRef && sessionRef.kind === "path") {
    return describeFile(sessionRef.value);
  }

  const id = sessionRef && sessionRef.value;

  if (agent === "agy") {
    const agyFile = resolveAgyFallback(homedir, env, id);
    if (agyFile) return describeFile(agyFile);
  }

  const primary = () => {
    if (store.strategy === "sqlite") {
      const dbPath = firstExisting(store.dbPaths(homedir, env));
      if (!dbPath) {
        throw new SourceContextUnavailable(`${agent} session database not found`);
      }
      return { strategy: "sqlite", dbPath, sessionId: id };
    }
    const root = firstExisting(store.roots(homedir, env));
    if (!root) {
      throw new SourceContextUnavailable(`${agent} session store directory not found`);
    }
    const matches = search(root, store, id);
    if (matches.length === 0) {
      throw new SourceContextUnavailable(`no session file for ${agent} session ${id}`);
    }
    if (matches.length > 1) {
      throw new SourceContextUnavailable(
        `more than one candidate session file for ${agent} session ${id}`
      );
    }
    return describeFile(matches[0]);
  };

  const attemptRecovery = () => {
    if (!cwd || !store.recover) return null;
    const recovered = store.recover(homedir, cwd, env);
    return recovered || null;
  };

  if (id) {
    try {
      return primary();
    } catch (err) {
      if (!(err instanceof SourceContextUnavailable) || !recoverableFailure(err)) throw err;
      const recovered = attemptRecovery();
      if (recovered) return recovered;
      throw err;
    }
  }

  if (SOURCE_KINDS.has(agent)) {
    const recovered = attemptRecovery();
    if (recovered) return recovered;
    throw new SourceContextUnavailable(`Herdr reported no session reference for ${agent}`);
  }

  const recovered = attemptRecovery();
  if (recovered) return recovered;
  if (store.noRecord) {
    throw new SourceContextUnavailable(store.noRecord(cwd || homedir));
  }
  throw new SourceContextUnavailable(
    `${agent} reports no session identity to Herdr, so it cannot be a handoff source`
  );
}

module.exports = {
  resolve, countLines, STORES, SourceContextUnavailable,
  sameCwd, piDirName, claudeDirName, recoverableFailure,
};
