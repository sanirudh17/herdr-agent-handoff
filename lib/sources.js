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
  },
  codex: {
    strategy: "file",
    verified: true,
    roots: (home, env) => [
      env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : null,
      join(home, ".codex", "sessions"),
    ],
    fileMatch: (base, id) => base.startsWith("rollout-") && base.endsWith(`-${id}.jsonl`),
  },
  pi: {
    strategy: "file",
    verified: true,
    roots: (home) => [join(home, ".pi", "agent", "sessions")],
    fileMatch: (base, id) => base.endsWith(`_${id}.jsonl`),
  },
  opencode: {
    strategy: "sqlite",
    verified: true,
    dbPaths: (home, env) => [
      env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "opencode", "opencode.db") : null,
      join(home, ".local", "share", "opencode", "opencode.db"),
      join(home, "Library", "Application Support", "opencode", "opencode.db"),
    ],
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
};

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

function resolve({ agent, sessionRef, env = process.env, homedir = os.homedir() }) {
  if (!SOURCE_KINDS.has(agent)) {
    throw new SourceContextUnavailable(
      `${agent} reports no session identity to Herdr, so it cannot be a handoff source`
    );
  }

  const store = STORES[agent];
  if (!store) {
    throw new SourceContextUnavailable(`no session store is configured for ${agent}`);
  }

  if (!sessionRef || !sessionRef.value) {
    throw new SourceContextUnavailable(`Herdr reported no session reference for ${agent}`);
  }

  if (sessionRef.kind === "path") {
    return describeFile(sessionRef.value);
  }

  const id = sessionRef.value;

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
}

module.exports = { resolve, countLines, STORES, SourceContextUnavailable };
