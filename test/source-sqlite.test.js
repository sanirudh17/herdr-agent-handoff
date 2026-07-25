const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extract, hasSqlite } = require("../lib/source-sqlite.js");

const SKIP = !hasSqlite() ? "node:sqlite unavailable (needs Node 22.5+)" : false;
const SID = "ses_06af8a6fcffeIyWB7w5lX0xE7y";
const OTHER = "ses_ffffffffffffZZZZZZZZZZZZZZ";

function buildDb() {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-oc-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
      agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT, seq INTEGER);
    CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT,
      position INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?)")
    .run(SID, "proj", "/w", "Fix the parser", "build", "opus", 1, 2);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?)")
    .run(OTHER, "proj", "/w", "Unrelated", "build", "opus", 1, 2);
  // Insert out of chronological order to prove the exporter sorts.
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m2", SID, 20, 20, '{"role":"assistant"}');
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m1", SID, 10, 10, '{"role":"user"}');
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("mX", OTHER, 10, 10, '{"role":"user"}');
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p2", "m1", SID, 12, 12, '{"type":"text","text":"beta"}');
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p1", "m1", SID, 11, 11, '{"type":"text","text":"alpha"}');
  db.prepare("INSERT INTO todo VALUES (?,?,?,?,?,?,?)").run(SID, "Ship it", "pending", "high", 0, 1, 1);
  db.prepare("INSERT INTO event VALUES (?,?,?,?,?)").run("e1", SID, 1, "message.updated.1", "{}");
  db.close();
  return dbPath;
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

test("hasSqlite reflects node:sqlite availability", () => {
  assert.equal(typeof hasSqlite(), "boolean");
});

test("extract emits every row for the session in deterministic order", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const out = extract({ dbPath, sessionId: SID, workDir });
  const rows = readLines(out.jsonlPath);

  assert.deepEqual(
    rows.map((r) => r.table),
    ["session", "message", "message", "part", "part", "todo", "event"]
  );
  assert.deepEqual(rows.filter((r) => r.table === "message").map((r) => r.row.id), ["m1", "m2"]);
  assert.deepEqual(rows.filter((r) => r.table === "part").map((r) => r.row.id), ["p1", "p2"]);
  assert.equal(out.lines, rows.length);
  assert.equal(out.counts.message, 2);
  assert.equal(out.counts.part, 2);
  assert.equal(out.counts.event, 1);
});

test("extract excludes rows belonging to other sessions", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const out = extract({ dbPath, sessionId: SID, workDir });
  const body = fs.readFileSync(out.jsonlPath, "utf8");
  assert.ok(!body.includes(OTHER), "other session ids must not leak into the export");
  assert.ok(!body.includes("Unrelated"));
});

test("extract preserves data payloads byte-identically", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const out = extract({ dbPath, sessionId: SID, workDir });
  const parts = readLines(out.jsonlPath).filter((r) => r.table === "part");
  assert.equal(parts[0].row.data, '{"type":"text","text":"alpha"}');
  assert.equal(parts[1].row.data, '{"type":"text","text":"beta"}');
});

test("extract never modifies the source database", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const before = fs.statSync(dbPath).mtimeMs;
  const out = extract({ dbPath, sessionId: SID, workDir });
  assert.equal(fs.statSync(dbPath).mtimeMs, before, "source database must not be modified");
  assert.equal(out.opened, "direct", "a healthy database should be read in place");
});

test("extract can read from a copy when a direct open is impossible", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const before = fs.statSync(dbPath).mtimeMs;
  const out = extract({ dbPath, sessionId: SID, workDir, mode: "copy" });
  assert.equal(out.opened, "copy");
  assert.equal(out.counts.message, 2);
  assert.equal(fs.statSync(dbPath).mtimeMs, before, "source database must not be modified");
  assert.ok(
    !fs.existsSync(path.join(workDir, "opencode-copy.db")),
    "the working copy must be cleaned up"
  );
});

test("extract rejects a session with no rows", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  assert.throws(() => extract({ dbPath, sessionId: "ses_missing", workDir }), /no opencode session/);
});

test("extract rejects a session row with no messages", { skip: SKIP }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = buildDb();
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM message WHERE session_id = ?").run(SID);
  db.close();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  assert.throws(() => extract({ dbPath, sessionId: SID, workDir }), /no messages/);
});

test("extract succeeds when the event log has been pruned", { skip: SKIP }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = buildDb();
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM event WHERE aggregate_id = ?").run(SID);
  db.close();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const out = extract({ dbPath, sessionId: SID, workDir });
  assert.equal(out.counts.event, 0);
  assert.ok(out.lines > 0);
});

test("extract tolerates a database missing the newer tables", { skip: SKIP }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = buildDb();
  const db = new DatabaseSync(dbPath);
  db.exec("DROP TABLE session_message; DROP TABLE todo;");
  db.close();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const out = extract({ dbPath, sessionId: SID, workDir });
  assert.equal(out.counts.session_message, 0);
  assert.equal(out.counts.todo, 0);
});
