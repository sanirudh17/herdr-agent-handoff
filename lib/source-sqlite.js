"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class SqliteUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteUnavailable";
  }
}

function loadSqlite() {
  try {
    // node:sqlite landed in Node 22.5 and is unavailable on older runtimes.
    return require("node:sqlite");
  } catch {
    return null;
  }
}

function hasSqlite() {
  return loadSqlite() !== null;
}

// Fixed export order. `where` names the column holding the session id, and
// `order` is the deterministic sort applied within the table.
const TABLES = [
  { name: "session", where: "id", order: "id" },
  { name: "message", where: "session_id", order: "time_created, id" },
  { name: "part", where: "session_id", order: "message_id, time_created, id" },
  { name: "session_message", where: "session_id", order: "seq, id" },
  { name: "todo", where: "session_id", order: "position" },
  { name: "event", where: "aggregate_id", order: "seq" },
];

// Table/column identifiers can't be bound as SQL parameters, so every value
// interpolated into a query is validated against a strict identifier shape
// before use, closing off injection even though TABLES is a fixed constant.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeIdentifier(id) {
  if (!IDENTIFIER.test(id)) {
    throw new Error(`unsafe SQL identifier: ${id}`);
  }
  return id;
}

function safeOrderBy(order) {
  return order
    .split(",")
    .map((col) => assertSafeIdentifier(col.trim()))
    .join(", ");
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function copyDatabase(dbPath, workDir) {
  const copy = path.join(workDir, "opencode-copy.db");
  fs.mkdirSync(workDir, { recursive: true });
  fs.copyFileSync(dbPath, copy);
  // opencode runs in WAL mode. Copying the sidecars lets SQLite recover a
  // consistent view from the copied WAL.
  for (const suffix of ["-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, copy + suffix);
  }
  return copy;
}

// A read-only connection to a WAL database gets a consistent snapshot even
// while opencode is writing, so the live file is read in place. That matters:
// this database is routinely hundreds of megabytes, and copying it on every
// handoff would be wasteful. The copy is a fallback for the case where a
// read-only open is refused outright (a -wal needing recovery, for instance).
function openReadOnly(sqlite, dbPath, workDir, mode) {
  if (mode !== "copy") {
    try {
      return {
        db: new sqlite.DatabaseSync(dbPath, { readOnly: true }),
        opened: "direct",
        copies: [],
      };
    } catch {
      // fall through to the copy strategy
    }
  }
  const copy = copyDatabase(dbPath, workDir);
  return {
    db: new sqlite.DatabaseSync(copy, { readOnly: true }),
    opened: "copy",
    copies: [copy, `${copy}-wal`, `${copy}-shm`],
  };
}

function extractToBuffer({ dbPath, sessionId, workDir, mode = "auto" }) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new SqliteUnavailable(
      "node:sqlite is unavailable; Node 22.5 or newer is required",
    );
  }

  // Only the copy fallback needs somewhere to work, and it cleans up after itself.
  const scratch =
    workDir || fs.mkdtempSync(path.join(os.tmpdir(), "herdr-oc-"));
  const { db, opened, copies } = openReadOnly(sqlite, dbPath, scratch, mode);
  const counts = {};
  const chunks = [];

  try {
    for (const table of TABLES) {
      if (!tableExists(db, table.name)) {
        counts[table.name] = 0;
        continue;
      }
      const selectSql =
        'SELECT * FROM "' +
        assertSafeIdentifier(table.name) +
        '" WHERE "' +
        assertSafeIdentifier(table.where) +
        '" = ? ORDER BY ' +
        safeOrderBy(table.order);
      const rows = db.prepare(selectSql).all(sessionId);
      counts[table.name] = rows.length;
      for (const row of rows) {
        chunks.push(JSON.stringify({ table: table.name, row }) + "\n");
      }
    }

    if (counts.session === 0) {
      throw new SqliteUnavailable(
        `no opencode session found for id ${sessionId}`,
      );
    }
    if (counts.message === 0) {
      throw new SqliteUnavailable(
        `opencode session ${sessionId} has no messages`,
      );
    }

    const body = Buffer.from(chunks.join(""), "utf8");

    // Re-query after the export and assert nothing was dropped.
    const emitted = chunks.length;
    let recount = 0;
    for (const table of TABLES) {
      if (!tableExists(db, table.name)) continue;
      const countSql =
        'SELECT COUNT(*) AS c FROM "' +
        assertSafeIdentifier(table.name) +
        '" WHERE "' +
        assertSafeIdentifier(table.where) +
        '" = ?';
      recount += db.prepare(countSql).get(sessionId).c;
    }
    if (recount !== emitted) {
      throw new SqliteUnavailable(
        `opencode export is incomplete: emitted ${emitted} rows but the database holds ${recount}`,
      );
    }

    return { body, lines: emitted, bytes: body.length, counts, opened };
  } finally {
    db.close();
    for (const file of copies) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best effort
      }
    }
    if (!workDir) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

// Kept for the one documented exception: an opencode session too large to inline
// has to be materialised somewhere, because its store is a single database with
// no per-session files.
function extract(opts) {
  const result = extractToBuffer(opts);
  fs.mkdirSync(opts.workDir, { recursive: true });
  const jsonlPath = path.join(opts.workDir, "opencode-session.jsonl");
  fs.writeFileSync(jsonlPath, result.body);
  return {
    jsonlPath,
    lines: result.lines,
    bytes: result.bytes,
    counts: result.counts,
    opened: result.opened,
  };
}

function exportPathFor(dbPath, sessionId) {
  return path.join(path.dirname(dbPath), `herdr-handoff-${sessionId}.jsonl`);
}

module.exports = {
  extract,
  extractToBuffer,
  exportPathFor,
  hasSqlite,
  SqliteUnavailable,
};
