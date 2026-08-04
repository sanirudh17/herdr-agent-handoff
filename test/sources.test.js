const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolve, SourceContextUnavailable } = require("../lib/sources.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-home-"));
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";
const BODY = '{"a":1}\n{"b":2}\n';

test("kind:path is used directly without searching", () => {
  const home = tmpHome();
  const file = writeFile(path.join(home, "anywhere", "session.jsonl"), BODY);
  const got = resolve({
    agent: "pi",
    sessionRef: { kind: "path", value: file },
    homedir: home,
    env: {},
  });
  assert.equal(got.strategy, "file");
  assert.equal(got.path, file);
  assert.equal(got.lines, 2);
  assert.equal(got.bytes, Buffer.byteLength(BODY));
});

test("claude resolves <id>.jsonl under any project directory", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(home, ".claude", "projects", "C--Users-x-proj", `${ID}.jsonl`),
    BODY,
  );
  const got = resolve({
    agent: "claude",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("claude honours CLAUDE_CONFIG_DIR", () => {
  const home = tmpHome();
  const alt = tmpHome();
  const file = writeFile(path.join(alt, "projects", "p", `${ID}.jsonl`), BODY);
  const got = resolve({
    agent: "claude",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: { CLAUDE_CONFIG_DIR: alt },
  });
  assert.equal(got.path, file);
});

test("codex resolves rollout-<date>-<id>.jsonl under nested date directories", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "07",
      "10",
      `rollout-2026-07-10T16-46-08-${ID}.jsonl`,
    ),
    BODY,
  );
  const got = resolve({
    agent: "codex",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("pi resolves <timestamp>_<id>.jsonl", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      "--C--proj--",
      `2026-07-24T17-10-59-546Z_${ID}.jsonl`,
    ),
    BODY,
  );
  const got = resolve({
    agent: "pi",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("opencode returns a sqlite descriptor rather than a file", () => {
  const home = tmpHome();
  const db = writeFile(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    "x",
  );
  const got = resolve({
    agent: "opencode",
    sessionRef: { kind: "id", value: "ses_06af8a" },
    homedir: home,
    env: {},
  });
  assert.equal(got.strategy, "sqlite");
  assert.equal(got.dbPath, db);
  assert.equal(got.sessionId, "ses_06af8a");
});

test("kinds with no session store at all are refused outright", () => {
  const home = tmpHome();
  for (const agent of ["gemini", "kiro", "amp", "maki"]) {
    assert.throws(
      () =>
        resolve({
          agent,
          sessionRef: { kind: "id", value: ID },
          homedir: home,
          env: {},
        }),
      (err) => {
        assert.ok(err instanceof SourceContextUnavailable);
        assert.equal(
          err.reason,
          `${agent} reports no session identity to Herdr, so it cannot be a handoff source`,
        );
        return true;
      },
    );
  }
});

test("recoverable kinds refuse when their store is absent and no cwd keys a recovery", () => {
  const home = tmpHome();
  for (const agent of ["cline", "grok"]) {
    assert.throws(
      () =>
        resolve({
          agent,
          sessionRef: { kind: "id", value: ID },
          homedir: home,
          env: {},
        }),
      (err) => {
        assert.ok(err instanceof SourceContextUnavailable);
        assert.equal(err.reason, `${agent} session store directory not found`);
        return true;
      },
    );
  }
});

test("a missing session reference is refused", () => {
  const home = tmpHome();
  assert.throws(
    () =>
      resolve({ agent: "claude", sessionRef: null, homedir: home, env: {} }),
    SourceContextUnavailable,
  );
});

test("zero matches is a hard failure", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        homedir: home,
        env: {},
      }),
    SourceContextUnavailable,
  );
});

test("more than one match is a hard failure rather than a guess", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), BODY);
  writeFile(path.join(home, ".claude", "projects", "b", `${ID}.jsonl`), BODY);
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        homedir: home,
        env: {},
      }),
    (err) => {
      assert.match(err.reason, /more than one/);
      return true;
    },
  );
});

test("an empty transcript is a hard failure", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), "");
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        homedir: home,
        env: {},
      }),
    SourceContextUnavailable,
  );
});

test("a kind:path value that does not exist is a hard failure", () => {
  const home = tmpHome();
  assert.throws(
    () =>
      resolve({
        agent: "pi",
        sessionRef: { kind: "path", value: path.join(home, "nope.jsonl") },
        homedir: home,
        env: {},
      }),
    SourceContextUnavailable,
  );
});

// ---------------------------------------------------------------------------
// Recovery by cwd: when the native reference is missing or points at nothing,
// the pane's working directory keys into each agent's own store. Only a unique
// match is ever used; anything ambiguous fails closed.
// ---------------------------------------------------------------------------

const CWD = "C:\\Users\\sanir\\Herdr Plugin";
const { piDirName, claudeDirName } = require("../lib/sources.js");

function piSessionDir(home) {
  return path.join(home, ".pi", "agent", "sessions", piDirName(CWD));
}

function claudeProjectDir(home) {
  return path.join(home, ".claude", "projects", claudeDirName(CWD));
}

const ROLLOUT = (id) =>
  `${JSON.stringify({ type: "session_meta", payload: { cwd: CWD, session_id: id } })}\n` +
  BODY;

function setMtime(file, ms) {
  const t = new Date(ms * 1000);
  fs.utimesSync(file, t, t);
}

test("pi: a missing reference recovers to the pane's one session file by cwd", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(piSessionDir(home), `2026-07-24T00-00-00-000Z_${ID}.jsonl`),
    BODY,
  );
  const got = resolve({
    agent: "pi",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
  assert.equal(got.lines, 2);
});

test("pi: a stale reference recovers when its own file is gone but the cwd matches", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(piSessionDir(home), `2026-07-24T00-00-00-000Z_${ID}.jsonl`),
    BODY,
  );
  const got = resolve({
    agent: "pi",
    sessionRef: { kind: "id", value: "019f0000-0000-0000-0000-000000000000" },
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("pi: two sessions for one cwd refuses to guess which is active", () => {
  const home = tmpHome();
  writeFile(
    path.join(piSessionDir(home), `2026-07-24T00-00-00-000Z_a.jsonl`),
    BODY,
  );
  writeFile(
    path.join(piSessionDir(home), `2026-07-24T00-00-00-000Z_b.jsonl`),
    BODY,
  );
  assert.throws(
    () =>
      resolve({
        agent: "pi",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /refusing to guess/.test(err.reason),
  );
});

test("pi: no session recorded for the cwd still reports the missing reference", () => {
  const home = tmpHome();
  assert.throws(
    () =>
      resolve({
        agent: "pi",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /reported no session reference/.test(err.reason),
  );
});

test("claude: a missing reference recovers to the pane's one transcript by cwd", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(claudeProjectDir(home), `${ID}.jsonl`),
    BODY,
  );
  const got = resolve({
    agent: "claude",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("claude: two transcripts for one project refuse to guess", () => {
  const home = tmpHome();
  writeFile(path.join(claudeProjectDir(home), `a.jsonl`), BODY);
  writeFile(path.join(claudeProjectDir(home), `b.jsonl`), BODY);
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /refusing to guess/.test(err.reason),
  );
});

test("codex: recovery scans rollouts for the first-line payload cwd and takes the newest", () => {
  const home = tmpHome();
  const dir = path.join(home, ".codex", "sessions", "2026", "07", "10");
  const oldFile = writeFile(
    path.join(dir, "rollout-2026-07-10T10-00-00-a.jsonl"),
    ROLLOUT("a"),
  );
  const newFile = writeFile(
    path.join(dir, "rollout-2026-07-10T16-00-00-b.jsonl"),
    ROLLOUT("b"),
  );
  setMtime(oldFile, 1000);
  setMtime(newFile, 2000);
  const got = resolve({
    agent: "codex",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, newFile);
});

test("codex: rollouts of equal age refuse to guess", () => {
  const home = tmpHome();
  const dir = path.join(home, ".codex", "sessions", "2026", "07", "10");
  const a = writeFile(
    path.join(dir, "rollout-2026-07-10T10-00-00-a.jsonl"),
    ROLLOUT("a"),
  );
  const b = writeFile(
    path.join(dir, "rollout-2026-07-10T16-00-00-b.jsonl"),
    ROLLOUT("b"),
  );
  setMtime(a, 1000);
  setMtime(b, 1000);
  assert.throws(
    () =>
      resolve({
        agent: "codex",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /equally recent/.test(err.reason),
  );
});

test("cline: sessions.db matches the pane cwd and prefers the open session", () => {
  const home = tmpHome();
  const data = path.join(home, ".cline", "data");
  const dbPath = writeFile(path.join(data, "db", "sessions.db"), "");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE sessions (session_id TEXT, started_at TEXT, ended_at TEXT, cwd TEXT, workspace_root TEXT)",
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
    "old-closed",
    "2026-07-24T09:00:00.000Z",
    "2026-07-24T10:00:00.000Z",
    CWD,
    CWD,
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
    "new-open",
    "2026-07-25T09:00:00.000Z",
    null,
    CWD,
    CWD,
  );
  db.close();
  const file = writeFile(
    path.join(data, "sessions", "new-open", "new-open.messages.json"),
    BODY,
  );
  const got = resolve({
    agent: "cline",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("cline: without an open row the newest closed session is used", () => {
  const home = tmpHome();
  const data = path.join(home, ".cline", "data");
  const dbPath = writeFile(path.join(data, "db", "sessions.db"), "");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE sessions (session_id TEXT, started_at TEXT, ended_at TEXT, cwd TEXT, workspace_root TEXT)",
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
    "old",
    "2026-07-24T09:00:00.000Z",
    "2026-07-24T10:00:00.000Z",
    CWD,
    CWD,
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
    "new",
    "2026-07-25T09:00:00.000Z",
    "2026-07-25T10:00:00.000Z",
    CWD,
    CWD,
  );
  db.close();
  const file = writeFile(
    path.join(data, "sessions", "new", "new.messages.json"),
    BODY,
  );
  const got = resolve({
    agent: "cline",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("cline: metadata files are the fallback when the database is absent", () => {
  const home = tmpHome();
  const data = path.join(home, ".cline", "data");
  writeFile(
    path.join(data, "sessions", "meta-session", "meta-session.json"),
    JSON.stringify({
      session_id: "meta-session",
      workspace_root: CWD,
      started_at: "2026-07-25T09:00:00.000Z",
    }),
  );
  const file = writeFile(
    path.join(data, "sessions", "meta-session", "meta-session.messages.json"),
    BODY,
  );
  const got = resolve({
    agent: "cline",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("grok: the search index resolves a cwd case-insensitively into a content snapshot", () => {
  const home = tmpHome();
  const dir = path.join(home, ".grok", "sessions");
  const dbPath = writeFile(path.join(dir, "session_search.sqlite"), "");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session_docs (session_id TEXT, cwd TEXT, updated_at INTEGER, content TEXT)",
  );
  db.prepare("INSERT INTO session_docs VALUES (?,?,?,?)").run(
    "old",
    CWD.toLowerCase(),
    1000,
    "old body",
  );
  db.prepare("INSERT INTO session_docs VALUES (?,?,?,?)").run(
    "fresh",
    CWD,
    2000,
    "fresh body",
  );
  db.close();
  const got = resolve({
    agent: "grok",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  assert.equal(got.strategy, "sqlite-content");
  assert.equal(got.sessionId, "fresh");
  assert.equal(got.body.toString("utf8"), "fresh body");
});

test("grok: sessions of equal age for one cwd refuse to guess", () => {
  const home = tmpHome();
  const dir = path.join(home, ".grok", "sessions");
  const dbPath = writeFile(path.join(dir, "session_search.sqlite"), "");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session_docs (session_id TEXT, cwd TEXT, updated_at INTEGER, content TEXT)",
  );
  db.prepare("INSERT INTO session_docs VALUES (?,?,?,?)").run(
    "a",
    CWD,
    1000,
    "a",
  );
  db.prepare("INSERT INTO session_docs VALUES (?,?,?,?)").run(
    "b",
    CWD,
    1000,
    "b",
  );
  db.close();
  assert.throws(
    () =>
      resolve({
        agent: "grok",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /equally recent/.test(err.reason),
  );
});

test("cline and grok name why no record exists instead of claiming no identity", () => {
  const home = tmpHome();
  assert.throws(
    () =>
      resolve({
        agent: "cline",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /no persisted session/.test(err.reason),
  );
  assert.throws(
    () =>
      resolve({
        agent: "grok",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /no indexed session/.test(err.reason),
  );
});

test("an ambiguity in the primary search is never papered over by recovery", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), BODY);
  writeFile(path.join(home, ".claude", "projects", "b", `${ID}.jsonl`), BODY);
  writeFile(path.join(claudeProjectDir(home), `${ID}.jsonl`), BODY);
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /more than one/.test(err.reason),
  );
});

test("best-effort agents match any recognised extension containing the id", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(home, ".factory", "sessions", `conv-${ID}.json`),
    BODY,
  );
  const got = resolve({
    agent: "droid",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("counts lines correctly when the file has no trailing newline", () => {
  const home = tmpHome();
  writeFile(
    path.join(home, ".claude", "projects", "a", `${ID}.jsonl`),
    '{"a":1}\n{"b":2}',
  );
  const got = resolve({
    agent: "claude",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.lines, 2);
});

test("opencode: without a reference, recovery keys on the pane cwd", () => {
  const home = tmpHome();
  const dbPath = writeFile(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    "",
  );
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT, time_archived INTEGER)",
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_old",
    "C:/Users/sanir/Herdr Plugin",
    1000,
    null,
    null,
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_fwd",
    "C:/Users/sanir/Herdr plugin",
    2000,
    null,
    null,
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_sub",
    "C:/Users/sanir/Herdr Plugin",
    3000,
    "ses_old",
    null,
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_arch",
    "C:/Users/sanir/Herdr Plugin",
    4000,
    null,
    5000,
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_other",
    "C:/Other",
    9999,
    null,
    null,
  );
  db.close();
  const got = resolve({
    agent: "opencode",
    sessionRef: null,
    cwd: CWD,
    homedir: home,
    env: {},
  });
  // newest unarchived top-level row for the pane cwd, across case and slash variants
  assert.equal(got.strategy, "sqlite");
  assert.equal(got.sessionId, "ses_fwd");
  assert.equal(got.dbPath, dbPath);
});

test("opencode: sessions of equal activity for one cwd refuse to guess", () => {
  const home = tmpHome();
  const dbPath = writeFile(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    "",
  );
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT, time_archived INTEGER)",
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_a",
    "C:/Users/sanir/Herdr Plugin",
    7,
    null,
    null,
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_b",
    "C:/Users/sanir/Herdr Plugin",
    7,
    null,
    null,
  );
  db.close();
  assert.throws(
    () =>
      resolve({
        agent: "opencode",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /equally recent/.test(err.reason),
  );
});

test("opencode: no session for the pane cwd reports the missing store record", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".local", "share", "opencode", "opencode.db"), "");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
  );
  db.exec(
    "CREATE TABLE session (id TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT, time_archived INTEGER)",
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(
    "ses_x",
    "C:/Elsewhere",
    1,
    null,
    null,
  );
  db.close();
  assert.throws(
    () =>
      resolve({
        agent: "opencode",
        sessionRef: null,
        cwd: CWD,
        homedir: home,
        env: {},
      }),
    (err) =>
      err instanceof SourceContextUnavailable &&
      /no session reference/.test(err.reason),
  );
});

test("a source kind whose store is absent says the store is missing, not the identity", () => {
  const home = tmpHome();
  const { STORES } = require("../lib/sources.js");
  const hermes = STORES.hermes;
  delete STORES.hermes; // defensive branch: a future store removal stays honest
  try {
    assert.throws(
      () =>
        resolve({
          agent: "hermes",
          sessionRef: { kind: "id", value: ID },
          homedir: home,
          env: {},
        }),
      (err) =>
        err instanceof SourceContextUnavailable &&
        /no session store is configured/.test(err.reason),
    );
  } finally {
    STORES.hermes = hermes;
  }
});
