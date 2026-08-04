# Prompt-Only Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the entire agent handoff inside the prompt so the plugin writes no files, and replace the inert prompt-line readiness rule with a line-shaped detector that actually fires.

**Architecture:** `briefing.build()` assembles one prompt string and picks between two modes by measuring the assembled result against a 30,000-character budget: inline (transcript embedded, nothing on disk) or reference (the source agent's own native transcript named with its pinned line count, SHA-256 and ordered line ranges). `snapshot.js` stops copying and only measures. `handoff.js` stops writing `HANDOFF.md`, and `readScreen` returns raw text so a line-shaped input-box detector can tell a startup banner above the prompt from live state below it.

**Tech Stack:** Node.js CommonJS, zero runtime dependencies, `node:test`, `node:crypto`, `node:sqlite` (Node ≥ 22.5).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-prompt-only-handoff-design.md`. It supersedes sections 8–9 of `2026-07-25-agent-handoff-design.md` and revises section 7.
- Prompt ceiling is **32,767** characters for the whole command line; the prompt budget is **30,000**. Every assembled prompt must be asserted under budget.
- Inline transcript budget is whatever remains of 30,000 after prose. Mode selection is decided on the **assembled** prompt, never on an estimate.
- Range size is **1,200 lines**; at most **40** ranges are enumerated before degrading to a stated rule.
- Readability gate: first 64 KB has no NUL byte, decodes as UTF-8 without replacement characters, and contains at least one newline.
- Sentinel line, verbatim, ends every prompt and is the primary delivery marker: `-- end of handoff, begin now --`
- Failure message, verbatim, for any case where complete context cannot be delivered: `Full handoff unavailable: complete session context could not be retrieved for this source agent.` (already `MESSAGES.noContext`)
- The plugin writes **no files**, with exactly one documented exception: opencode over budget (Task 11).
- The source pane is never written to, closed, interrupted, or sent input.
- Never weaken delivery proof to "the screen changed" or "the agent changed state". Both were tried on this branch and both announced handoffs that had not happened.
- Windows is the primary test platform. Run tests with `node --test "test/**/*.test.js"` — a bare `test/` is resolved as a module and fails.
- Existing suite is 208 passing tests at commit `22f3dd0`. Never finish a task with a red suite.

---

### Task 1: Line-range arithmetic

**Files:**

- Create: `lib/ranges.js`
- Test: `test/ranges.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `ranges(totalLines, opts) -> { list: Array<{first:number,last:number}>, truncated:boolean, perRange:number, total:number }`. `opts` is `{ perRange = 1200, maxListed = 40 }`. `first`/`last` are 1-indexed and inclusive. When `truncated` is true, `list` holds the first `maxListed` ranges and the caller states a rule instead of enumerating.

- [ ] **Step 1: Write the failing test**

```js
// test/ranges.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ranges, PER_RANGE, MAX_LISTED } = require("../lib/ranges.js");

test("a session shorter than one range is a single range", () => {
  const r = ranges(500);
  assert.deepEqual(r.list, [{ first: 1, last: 500 }]);
  assert.equal(r.truncated, false);
  assert.equal(r.total, 500);
});

test("an exact multiple of the range size produces no empty trailing range", () => {
  const r = ranges(2400);
  assert.deepEqual(r.list, [
    { first: 1, last: 1200 },
    { first: 1201, last: 2400 },
  ]);
});

test("ranges cover every line exactly once with no gap and no overlap", () => {
  const total = 9_733;
  const r = ranges(total);
  assert.equal(r.list[0].first, 1);
  assert.equal(
    r.list[r.list.length - 1].last,
    total,
    "the last range ends at N",
  );
  for (let i = 1; i < r.list.length; i += 1) {
    assert.equal(
      r.list[i].first,
      r.list[i - 1].last + 1,
      `range ${i} starts right after ${i - 1}`,
    );
  }
  const covered = r.list.reduce((sum, x) => sum + (x.last - x.first + 1), 0);
  assert.equal(covered, total, "every line is covered exactly once");
});

test("past the listing cap the enumeration truncates rather than growing without bound", () => {
  const total = PER_RANGE * (MAX_LISTED + 15);
  const r = ranges(total);
  assert.equal(r.truncated, true);
  assert.equal(r.list.length, MAX_LISTED);
  assert.equal(r.total, total);
});

test("a session at the cap is not truncated", () => {
  const r = ranges(PER_RANGE * MAX_LISTED);
  assert.equal(r.truncated, false);
  assert.equal(r.list.length, MAX_LISTED);
});

test("an empty session yields no ranges", () => {
  assert.deepEqual(ranges(0).list, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ranges.test.js`
Expected: FAIL — `Cannot find module '../lib/ranges.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/ranges.js
"use strict";

// A transcript is handed over as ordered line ranges rather than copied part
// files. The reason is the same one the part files had: a single 568KB file
// invites a partial read. These are instructions, so they cost nothing on disk.
const PER_RANGE = 1200;
const MAX_LISTED = 40;

function ranges(totalLines, opts = {}) {
  const { perRange = PER_RANGE, maxListed = MAX_LISTED } = opts;
  const list = [];
  for (let first = 1; first <= totalLines; first += perRange) {
    list.push({ first, last: Math.min(first + perRange - 1, totalLines) });
  }
  const truncated = list.length > maxListed;
  return {
    list: truncated ? list.slice(0, maxListed) : list,
    truncated,
    perRange,
    total: totalLines,
  };
}

module.exports = { ranges, PER_RANGE, MAX_LISTED };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ranges.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/ranges.js test/ranges.test.js
git commit -m "feat: order a transcript into line ranges instead of copying parts"
```

---

### Task 2: Readability gate

**Files:**

- Modify: `lib/snapshot.js`
- Test: `test/snapshot.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `isReadableText(buffer) -> boolean`, exported from `lib/snapshot.js`. True only when the first 64 KB has no NUL byte, decodes as UTF-8 without a U+FFFD replacement character, and contains at least one newline.

- [ ] **Step 1: Write the failing test**

Append to `test/snapshot.test.js`:

```js
const { isReadableText, READABLE_PROBE_BYTES } = require("../lib/snapshot.js");

test("line-oriented UTF-8 text is readable", () => {
  const body = Buffer.from('{"a":1}\n{"a":2}\n', "utf8");
  assert.equal(isReadableText(body), true);
});

test("a NUL byte means it is not text a target can read", () => {
  const body = Buffer.concat([
    Buffer.from('{"a":1}\n'),
    Buffer.from([0x00]),
    Buffer.from("more\n"),
  ]);
  assert.equal(isReadableText(body), false);
});

test("invalid UTF-8 is not readable", () => {
  // 0xC3 starts a two-byte sequence; 0x28 cannot continue it.
  const body = Buffer.concat([Buffer.from([0xc3, 0x28]), Buffer.from("\n")]);
  assert.equal(isReadableText(body), false);
});

test("text with no newline at all is not line-oriented", () => {
  assert.equal(
    isReadableText(Buffer.from("one single line, no terminator", "utf8")),
    false,
  );
});

test("only the first 64KB is probed, so a late NUL does not disqualify a huge transcript", () => {
  const head = Buffer.from("{}\n".repeat(30000), "utf8");
  assert.ok(head.length > READABLE_PROBE_BYTES);
  const body = Buffer.concat([head, Buffer.from([0x00])]);
  assert.equal(isReadableText(body), true);
});

test("an empty buffer is not readable", () => {
  assert.equal(isReadableText(Buffer.alloc(0)), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/snapshot.test.js`
Expected: FAIL — `isReadableText is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `lib/snapshot.js` and include both names in `module.exports`:

```js
const READABLE_PROBE_BYTES = 64 * 1024;

// Mode 2 hands the target a path and tells it to read lines. That is only honest
// if the bytes at that path are lines. An unverified agent layout that resolves to
// a database or a binary blob fails here and the handoff reports that complete
// context could not be retrieved, rather than transferring something partial.
function isReadableText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const probe = buffer.subarray(0, READABLE_PROBE_BYTES);
  if (probe.includes(0x00)) return false;
  const text = new TextDecoder("utf8", { fatal: false }).decode(probe);
  if (text.includes("\uFFFD")) return false;
  return text.includes("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/snapshot.test.js`
Expected: PASS — the 6 new tests plus every test already in the file

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot.js test/snapshot.test.js
git commit -m "feat: gate the reference mode on the native file being readable lines"
```

---

### Task 3: Extract opencode rows without writing a file

**Files:**

- Modify: `lib/source-sqlite.js`
- Test: `test/source-sqlite.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `extractToBuffer({ dbPath, sessionId, workDir, mode }) -> { body: Buffer, lines: number, counts: object, opened: "direct"|"copy" }`. Writes nothing. `workDir` is used only by the copy fallback and defaults to a fresh directory under `os.tmpdir()`; any copy it makes is removed before returning. `extract({...})` keeps its current signature and return shape (`{ jsonlPath, lines, bytes, counts, opened }`) and is now a thin wrapper that writes `body` to `workDir`.
- Also produces: `exportPathFor(dbPath, sessionId) -> string`, the single file the opencode exception writes: `<dirname(dbPath)>/herdr-handoff-<sessionId>.jsonl`.

- [ ] **Step 1: Write the failing test**

Append to `test/source-sqlite.test.js`. Reuse whatever helper that file already has for building a temporary opencode database; if it builds one inline, follow the same shape.

```js
const { extractToBuffer, exportPathFor } = require("../lib/source-sqlite.js");

test("extractToBuffer returns the same bytes extract writes, and touches no disk", (t) => {
  const { dbPath, sessionId } = makeDb(); // same helper the file already uses
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-buf-"));

  const inMemory = extractToBuffer({ dbPath, sessionId, workDir });
  assert.deepEqual(
    fs.readdirSync(workDir),
    [],
    "extractToBuffer must not leave anything behind, not even a copy",
  );

  const onDisk = extract({ dbPath, sessionId, workDir });
  assert.deepEqual(
    inMemory.body,
    fs.readFileSync(onDisk.jsonlPath),
    "the buffer is byte-identical to the exported file",
  );
  assert.equal(inMemory.lines, onDisk.lines);
  assert.deepEqual(inMemory.counts, onDisk.counts);
});

test("the opencode export path sits beside the database and names the session", () => {
  const p = exportPathFor("/var/data/opencode/opencode.db", "ses_abc123");
  assert.equal(path.basename(p), "herdr-handoff-ses_abc123.jsonl");
  assert.equal(path.dirname(p), path.dirname("/var/data/opencode/opencode.db"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/source-sqlite.test.js`
Expected: FAIL — `extractToBuffer is not a function`

- [ ] **Step 3: Write minimal implementation**

In `lib/source-sqlite.js`, rename the body of `extract` to `extractToBuffer`, drop the file write from it, and make `extract` wrap it. Add `os` to the requires.

```js
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
      const rows = db
        .prepare(
          `SELECT * FROM "${table.name}" WHERE "${table.where}" = ? ORDER BY ${table.order}`,
        )
        .all(sessionId);
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
      recount += db
        .prepare(
          `SELECT COUNT(*) AS c FROM "${table.name}" WHERE "${table.where}" = ?`,
        )
        .get(sessionId).c;
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
```

Update the exports line to `module.exports = { extract, extractToBuffer, exportPathFor, hasSqlite, SqliteUnavailable };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/source-sqlite.test.js`
Expected: PASS — the 2 new tests plus every test already in the file

- [ ] **Step 5: Commit**

```bash
git add lib/source-sqlite.js test/source-sqlite.test.js
git commit -m "feat: read an opencode session into memory instead of onto disk"
```

---

### Task 4: Measure the session instead of copying it

**Files:**

- Modify: `lib/snapshot.js`
- Test: `test/snapshot.test.js`

**Interfaces:**

- Consumes: `isReadableText` (Task 2), `extractToBuffer` (Task 3).
- Produces: `measure({ resolved }) -> { strategy, nativePath, body: Buffer, bytes, lines, sha256, counts, readable }`. `nativePath` is the source agent's own file, or the database path for opencode. `counts` is the opencode row-count map or `null`. `readable` is `isReadableText(body)`.
- Removed, and every caller updated: `write`, `prune`, `makeReadOnly`, `stamp`, `MAX_BYTES`, `KEEP`. `chunk` is removed too — Task 1 replaced it.

- [ ] **Step 1: Write the failing test**

Replace the whole of `test/snapshot.test.js` with the readability tests from Task 2 plus these. Delete the tests covering `write`, `prune`, chunking and `SOURCE.json`; those behaviours are gone by design.

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  measure,
  isReadableText,
  READABLE_PROBE_BYTES,
} = require("../lib/snapshot.js");

// ... the six isReadableText tests from Task 2 go here ...

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, contents);
  return { dir, file };
}

test("a file session is measured, hashed and left exactly where it is", () => {
  const contents = '{"n":1}\n{"n":2}\n{"n":3}\n';
  const { dir, file } = tempFile(contents);
  const before = fs.readdirSync(dir);

  const m = measure({ resolved: { strategy: "file", path: file } });

  assert.equal(m.strategy, "file");
  assert.equal(m.nativePath, file);
  assert.equal(m.bytes, Buffer.byteLength(contents));
  assert.equal(m.lines, 3);
  assert.equal(
    m.sha256,
    crypto.createHash("sha256").update(contents).digest("hex"),
  );
  assert.equal(m.readable, true);
  assert.equal(m.counts, null);
  assert.equal(
    m.body.toString("utf8"),
    contents,
    "the body is the file byte for byte",
  );
  assert.deepEqual(fs.readdirSync(dir), before, "measuring writes nothing");
});

test("a final line without a trailing newline still counts", () => {
  const { file } = tempFile('{"n":1}\n{"n":2}');
  assert.equal(
    measure({ resolved: { strategy: "file", path: file } }).lines,
    2,
  );
});

test("an unreadable native file is measured but flagged, not thrown on", () => {
  const { file } = tempFile(Buffer.from([0x00, 0x01, 0x02]));
  const m = measure({ resolved: { strategy: "file", path: file } });
  assert.equal(m.readable, false, "the caller decides what to do about it");
});

test("measure no longer offers the copying API", () => {
  const snapshot = require("../lib/snapshot.js");
  for (const gone of ["write", "prune", "chunk"]) {
    assert.equal(
      snapshot[gone],
      undefined,
      `${gone} should be gone: nothing is copied any more`,
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/snapshot.test.js`
Expected: FAIL — `measure is not a function`

- [ ] **Step 3: Write minimal implementation**

Rewrite `lib/snapshot.js` to only measure. Keep `isReadableText` from Task 2.

```js
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  extractToBuffer,
  hasSqlite,
  SqliteUnavailable,
} = require("./source-sqlite.js");

const READABLE_PROBE_BYTES = 64 * 1024;

function isReadableText(buffer) {
  /* exactly as written in Task 2 */
}

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  if (buffer[buffer.length - 1] !== 0x0a) count += 1;
  return count;
}

// Nothing here writes. The transcript stays where its own agent put it; all we
// need is its size, its line count and a hash, so the prompt can pin exactly the
// session as it stood even though the file is live.
function measure({ resolved }) {
  if (resolved.strategy === "sqlite") {
    if (!hasSqlite()) {
      throw new SqliteUnavailable(
        "node:sqlite is unavailable; Node 22.5 or newer is required",
      );
    }
    const exported = extractToBuffer({
      dbPath: resolved.dbPath,
      sessionId: resolved.sessionId,
    });
    return {
      strategy: "sqlite",
      nativePath: resolved.dbPath,
      body: exported.body,
      bytes: exported.body.length,
      lines: countLines(exported.body),
      sha256: crypto.createHash("sha256").update(exported.body).digest("hex"),
      counts: exported.counts,
      readable: isReadableText(exported.body),
    };
  }

  const body = fs.readFileSync(resolved.path);
  return {
    strategy: "file",
    nativePath: resolved.path,
    body,
    bytes: body.length,
    lines: countLines(body),
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    counts: null,
    readable: isReadableText(body),
  };
}

module.exports = { measure, isReadableText, countLines, READABLE_PROBE_BYTES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/snapshot.test.js`
Expected: PASS. `node --test "test/**/*.test.js"` will now fail in `handoff.test.js` because `snapshot.write` is gone — that is expected and Task 10 fixes it.

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot.js test/snapshot.test.js
git commit -m "refactor: measure the source session rather than copying it"
```

---

### Task 5: The inline prompt

**Files:**

- Modify: `lib/briefing.js`
- Test: `test/briefing.test.js`

**Interfaces:**

- Consumes: `measure()` output (Task 4).
- Produces: `renderInline({ meta, session }) -> string` and the constants `SENTINEL` and `PROMPT_BUDGET` (30000), all exported from `lib/briefing.js`. `meta` is the object `handoff.run` already builds: `{ sourceKind, sourceName, targetKind, targetName, sessionId, sourcePaneId, workspaceId, tabId, cwd, destination, strategy, snapshotUtc }`. `session` is `measure()`'s return.
- `kickoff()` and `partsTable()` are removed.

- [ ] **Step 1: Write the failing test**

Replace `test/briefing.test.js`. Keep any existing assertions about the six rules by rewriting them against `renderInline`.

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderInline, SENTINEL, PROMPT_BUDGET } = require("../lib/briefing.js");

const META = {
  sourceKind: "codex",
  sourceName: "Codex",
  targetKind: "claude",
  targetName: "Claude Code",
  sessionId: "019d4393-fd0e-77f2-88a2-782589d290a5",
  sourcePaneId: "w6:p1",
  workspaceId: "w6",
  tabId: "w6:t1",
  cwd: "C:\\Users\\sanir\\Herdr plugin",
  destination: "tab",
  strategy: "file",
  snapshotUtc: "2026-07-26T09:30:00.000Z",
};

function sessionOf(text) {
  const body = Buffer.from(text, "utf8");
  return {
    strategy: "file",
    nativePath: "C:\\x\\rollout-1.jsonl",
    body,
    bytes: body.length,
    lines: text.split("\n").length - 1,
    sha256: "a".repeat(64),
    counts: null,
    readable: true,
  };
}

test("the prompt opens by telling the target it is taking over, and names the source", () => {
  const text = renderInline({ meta: META, session: sessionOf('{"n":1}\n') });
  assert.match(
    text,
    /^You are taking over this session from \*\*Codex\*\*/,
    "this exact opening was the requirement",
  );
});

test("the transcript is embedded verbatim, byte for byte", () => {
  const transcript =
    '{"role":"user","text":"hello ─ ❯ world"}\n{"role":"assistant"}\n';
  const text = renderInline({ meta: META, session: sessionOf(transcript) });
  assert.ok(
    text.includes(transcript),
    "no escaping, no reflowing, no truncation",
  );
});

test("the prompt states what to verify the transcript against", () => {
  const s = sessionOf('{"n":1}\n');
  const text = renderInline({ meta: META, session: s });
  assert.ok(
    text.includes(s.sha256),
    "the hash is stated so the target can confirm",
  );
  assert.ok(text.includes(String(s.bytes)), "so is the byte count");
});

test("all six rules survive into the prompt", () => {
  const text = renderInline({
    meta: META,
    session: sessionOf('{"n":1}\n'),
  }).toLowerCase();
  for (const rule of [
    "read the complete source session before acting",
    "treat it as historical context",
    "inspect the current workspace",
    "preserve uncommitted work",
    "continue from the exact stopping point",
    "do not redo completed investigation",
  ]) {
    assert.ok(text.includes(rule), `missing rule: ${rule}`);
  }
});

test("the source pane is declared off limits and named", () => {
  const text = renderInline({ meta: META, session: sessionOf('{"n":1}\n') });
  assert.ok(text.includes("w6:p1"));
  assert.match(text, /do not send it input/i);
});

test("the prompt ends with the sentinel, because that is the delivery marker", () => {
  const text = renderInline({ meta: META, session: sessionOf('{"n":1}\n') });
  assert.ok(
    text.trimEnd().endsWith(SENTINEL),
    "the marker must be the last thing on screen",
  );
  assert.equal(SENTINEL, "-- end of handoff, begin now --");
});

test("no reference to a handoff document survives", () => {
  const text = renderInline({ meta: META, session: sessionOf('{"n":1}\n') });
  assert.ok(!text.includes("HANDOFF.md"), "there is no document any more");
  assert.ok(!text.includes("SOURCE.json"));
});

test("the prose alone leaves real room for a transcript", () => {
  const overhead = renderInline({ meta: META, session: sessionOf("") }).length;
  assert.ok(
    overhead < 5000,
    `prose overhead is ${overhead}; it must leave >25k for the transcript`,
  );
  assert.ok(PROMPT_BUDGET === 30000);
});

test("briefing no longer offers the document-era API", () => {
  const briefing = require("../lib/briefing.js");
  assert.equal(briefing.kickoff, undefined);
  assert.equal(briefing.partsTable, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/briefing.test.js`
Expected: FAIL — `renderInline is not a function`

- [ ] **Step 3: Write minimal implementation**

Rewrite `lib/briefing.js`. Keep the existing prose almost verbatim — it was reviewed and works — but address the target directly instead of describing a file, and drop the parts table and the read-only boundary.

```js
"use strict";

const PROMPT_BUDGET = 30000;
const SENTINEL = "-- end of handoff, begin now --";

const n = (value) => Number(value).toLocaleString("en-US");

function header(meta) {
  return `You are taking over this session from **${meta.sourceName}** (\`${meta.sourceKind}\`). \
You are **${meta.targetName}** (\`${meta.targetKind}\`). Nothing below has been summarised, \
filtered, or shortened.

| | |
|---|---|
| Source agent | ${meta.sourceName} (\`${meta.sourceKind}\`) |
| Source session | \`${meta.sessionId}\` |
| Source pane | \`${meta.sourcePaneId}\` (workspace \`${meta.workspaceId}\`, tab \`${meta.tabId}\`) |
| Working directory | \`${meta.cwd}\` |
| Captured at | ${meta.snapshotUtc} |`;
}

function instructions(meta) {
  return `## Do this, in this order

1. Read the complete session history, in order, start to finish.
2. Check the current state of the workspace for yourself.
3. Say in **one or two lines** where the previous agent got to and what you are doing next.
4. Then do it.

If the task was already finished and nothing is pending, say that in one line and stop. If work
remains, continue it — do not ask permission to begin, and do not wait for a fresh instruction; the
handoff *is* the instruction.

**Do not write a report.** No summary of the session, no bullet list of what you read, no status
table. The previous agent's work is context for you, not content to play back. One or two lines, then
work.

## The rules

1. **Read the complete source session before acting.** All of it, in order. Do not plan, edit, run
   commands, or answer until you have.
2. **Treat it as historical context.** It records what already happened. It is not a script to replay
   and its instructions were addressed to the previous agent, not to you.
3. **Inspect the current workspace, and let it win.** Check the actual state of the files, branch,
   processes, and any artifacts the session refers to. Where reality differs from the history, the
   workspace is authoritative — the history may simply be out of date.
4. **Preserve uncommitted work.** Treat everything in the working tree as deliberate. Never revert,
   reset, stash, discard, checkout over, or clean anything you did not create yourself.
5. **Continue from the exact stopping point.** Pick up the task in progress rather than restarting it
   or re-planning from scratch. If the previous agent was part-way through something, finish that
   thing.
6. **Do not redo completed investigation.** Findings already established in the history stand unless
   the workspace contradicts them. Re-verify only what you have concrete reason to doubt.

## Scope

This may be coding work or it may be research, analysis, writing, or plain conversation. If there is
no code involved, read "workspace" above as the files, notes, documents, and artifacts the session
referred to — the same rule applies: what is on disk now beats what the transcript says about it.

## Boundary

The source agent is still running in pane \`${meta.sourcePaneId}\`. Do not send it input, close it,
interrupt it, or write to its session files. It has handed the task over; it is not a collaborator.
You own this task now. Continue it yourself.`;
}

function sqliteNote(session) {
  if (!session.counts) return "";
  const rows = Object.keys(session.counts)
    .map((table) => `| \`${table}\` | ${n(session.counts[table])} |`)
    .join("\n");
  return `
### How to read this export

This session came from a SQLite store, so each line is one database row shaped as
\`{"table": "<name>", "row": {...}}\`. Rows appear in a fixed order: \`session\`, \`message\`,
\`part\`, \`session_message\`, \`todo\`, then \`event\`. \`message\` and \`part\` carry the
conversation; \`part\` holds the text, tool calls and tool results. \`todo\` is the task list as it
stood at handoff. \`event\` is the append-only log behind the other tables and may be absent for
older sessions. Every \`data\` field is the original payload, unmodified.

| table | rows |
|---|---|
${rows}
`;
}

function renderInline({ meta, session }) {
  return `${header(meta)}
| Session history | inline below — ${n(session.lines)} lines, ${n(session.bytes)} bytes |
| SHA-256 | \`${session.sha256}\` |

## The complete session history

Everything between the fences is the source session, verbatim and complete. There is no file to open
and nothing else to fetch.
${sqliteNote(session)}
~~~~~~~~session
${session.body.toString("utf8")}
~~~~~~~~

${instructions(meta)}

${SENTINEL}
`;
}

module.exports = { renderInline, SENTINEL, PROMPT_BUDGET };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/briefing.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/briefing.js test/briefing.test.js
git commit -m "feat: carry the whole session inside the prompt when it fits"
```

---

### Task 6: The reference prompt

**Files:**

- Modify: `lib/briefing.js`
- Test: `test/briefing.test.js`

**Interfaces:**

- Consumes: `ranges()` (Task 1), `renderInline`'s shared helpers (Task 5).
- Produces: `renderReference({ meta, session }) -> string`, exported from `lib/briefing.js`. It calls `ranges(session.lines)` itself.

- [ ] **Step 1: Write the failing test**

Append to `test/briefing.test.js`:

```js
const { renderReference } = require("../lib/briefing.js");
const { PER_RANGE, MAX_LISTED } = require("../lib/ranges.js");

function bigSession(lines) {
  return {
    strategy: "file",
    nativePath:
      "C:\\Users\\sanir\\.codex\\sessions\\rollout-2026-03-31-019d4393.jsonl",
    body: Buffer.alloc(0),
    bytes: 581_632,
    lines,
    sha256: "b".repeat(64),
    counts: null,
    readable: true,
  };
}

test("the reference prompt names the agent's own file and pins what to read", () => {
  const s = bigSession(3000);
  const text = renderReference({ meta: META, session: s });
  assert.match(text, /^You are taking over this session from \*\*Codex\*\*/);
  assert.ok(text.includes(s.nativePath), "the target needs the path");
  assert.ok(text.includes("3,000"), "the pinned line count");
  assert.ok(text.includes(s.sha256));
});

test("line ranges are enumerated in order and stop at the pinned last line", () => {
  const text = renderReference({ meta: META, session: bigSession(3000) });
  assert.ok(text.includes("1–1200"));
  assert.ok(text.includes("1201–2400"));
  assert.ok(
    text.includes("2401–3000"),
    "the last range ends at N, not at a round number",
  );
});

test("reading past the pinned line is ruled out, because the file is live", () => {
  const text = renderReference({ meta: META, session: bigSession(3000) });
  assert.match(text, /do not read past line 3,000/i);
});

test("a very long session states the rule instead of listing every range", () => {
  const s = bigSession(PER_RANGE * (MAX_LISTED + 25));
  const text = renderReference({ meta: META, session: s });
  assert.ok(
    !text.includes(`${PER_RANGE * (MAX_LISTED + 20)}`),
    "no unbounded enumeration",
  );
  assert.match(text, /each following 1,200 lines/i, "a stated rule takes over");
  assert.ok(
    text.length < PROMPT_BUDGET,
    `reference prompt is ${text.length}, over budget`,
  );
});

test("the reference prompt also ends with the sentinel", () => {
  const text = renderReference({ meta: META, session: bigSession(3000) });
  assert.ok(text.trimEnd().endsWith(SENTINEL));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/briefing.test.js`
Expected: FAIL — `renderReference is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `lib/briefing.js`, requiring `./ranges.js` at the top, and add `renderReference` to the exports.

```js
const { ranges } = require("./ranges.js");

function rangeList(session) {
  const r = ranges(session.lines);
  const listed = r.list.map((x) => `- lines ${x.first}–${x.last}`).join("\n");
  if (!r.truncated) return listed;
  // Enumerating hundreds of ranges would crowd out the rules. State the rule instead.
  return `${listed}
- …and so on: each following ${n(r.perRange)} lines, in order, until line ${n(session.lines)}`;
}

function renderReference({ meta, session }) {
  return `${header(meta)}
| Session history | \`${session.nativePath}\` |
| Size | ${n(session.lines)} lines, ${n(session.bytes)} bytes |
| SHA-256 | \`${session.sha256}\` |

## The complete session history

The source agent's own transcript is at:

\`${session.nativePath}\`

It is too large to inline, so read it from there. It is ${n(session.lines)} lines. Read **every line
from 1 to ${n(session.lines)}, in order, start to finish** before you act. Do not sample it, do not
skim it, and do not stop early because a stretch looks repetitive. Read it in these ranges so a
single read never silently returns part of the file:

${rangeList(session)}

That file is still being written to by its own agent. Line ${n(session.lines)} is where the session
stood when it was handed to you, and the SHA-256 above covers exactly lines 1 to
${n(session.lines)} — **do not read past line ${n(session.lines)}**; anything beyond it is not part
of this handoff.
${sqliteNote(session)}
${instructions(meta)}

${SENTINEL}
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/briefing.test.js`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add lib/briefing.js test/briefing.test.js
git commit -m "feat: point at the agent's own transcript when it will not fit"
```

---

### Task 7: Budget and mode selection

**Files:**

- Modify: `lib/briefing.js`
- Test: `test/briefing.test.js`

**Interfaces:**

- Consumes: `renderInline` (Task 5), `renderReference` (Task 6), `isReadableText` result carried on `session.readable` (Task 2/4).
- Produces: `build({ meta, session }) -> { text, mode, markers } | null`. `mode` is `"inline"` or `"reference"`. `markers` is `[SENTINEL]` for inline, and `[SENTINEL, path.basename(session.nativePath)]` for reference. Returns **`null`** when the session is over budget and `session.readable` is false — the caller turns that into `MESSAGES.noContext`.

- [ ] **Step 1: Write the failing test**

Append to `test/briefing.test.js`:

```js
const path = require("node:path");
const { build } = require("../lib/briefing.js");

function fileSessionOfSize(bytes) {
  const line = '{"pad":"' + "x".repeat(98) + '"}\n';
  const body = Buffer.from(line.repeat(Math.ceil(bytes / line.length)), "utf8");
  return {
    strategy: "file",
    nativePath: "C:\\x\\rollout-1.jsonl",
    body,
    bytes: body.length,
    lines: body.toString("utf8").split("\n").length - 1,
    sha256: "c".repeat(64),
    counts: null,
    readable: true,
  };
}

test("a small session is delivered inline", () => {
  const built = build({ meta: META, session: fileSessionOfSize(2000) });
  assert.equal(built.mode, "inline");
  assert.deepEqual(built.markers, [SENTINEL]);
});

test("a large session switches to a reference, and says which file to look for", () => {
  const built = build({ meta: META, session: fileSessionOfSize(400_000) });
  assert.equal(built.mode, "reference");
  assert.deepEqual(built.markers, [SENTINEL, "rollout-1.jsonl"]);
});

test("both modes stay under the prompt budget, and well under the hard ceiling", () => {
  for (const bytes of [0, 1000, 20_000, 26_000, 30_000, 400_000, 14_000_000]) {
    const built = build({ meta: META, session: fileSessionOfSize(bytes) });
    assert.ok(
      built.text.length <= PROMPT_BUDGET,
      `${bytes}-byte session produced a ${built.text.length}-char prompt`,
    );
    assert.ok(
      built.text.length < 32_767,
      "the hard argv ceiling must never be reached",
    );
  }
});

test("the boundary is decided on the assembled prompt, not on an estimate", () => {
  // Walk the crossover and assert it is monotonic: once reference wins it never
  // goes back to inline. A mis-measured budget shows up here as a flip-flop.
  let seenReference = false;
  for (let bytes = 20_000; bytes <= 32_000; bytes += 500) {
    const mode = build({ meta: META, session: fileSessionOfSize(bytes) }).mode;
    if (mode === "reference") seenReference = true;
    else
      assert.equal(
        seenReference,
        false,
        `inline reappeared at ${bytes} bytes after reference`,
      );
  }
  assert.equal(
    seenReference,
    true,
    "somewhere in that walk it must stop fitting",
  );
});

test("an over-budget session that is not readable text yields no prompt at all", () => {
  const s = fileSessionOfSize(400_000);
  s.readable = false;
  assert.equal(
    build({ meta: META, session: s }),
    null,
    "the caller must report that complete context could not be retrieved",
  );
});

test("an unreadable session that fits inline is still fine: the bytes travel in the prompt", () => {
  const s = fileSessionOfSize(2000);
  s.readable = false;
  assert.equal(
    build({ meta: META, session: s }).mode,
    "inline",
    "readability only matters when the target has to open the file itself",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/briefing.test.js`
Expected: FAIL — `build is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `lib/briefing.js`, requiring `node:path` at the top, and add `build` to the exports.

```js
// The mode is chosen by building the inline prompt and measuring it, not by
// estimating from the session size. Fencing, the prose and the sqlite note all
// count against the ceiling, and a margin guessed in advance would drift.
function build({ meta, session }) {
  const inline = renderInline({ meta, session });
  if (inline.length <= PROMPT_BUDGET) {
    return { text: inline, mode: "inline", markers: [SENTINEL] };
  }
  // It has to be read from disk now, so it has to be readable from disk.
  if (!session.readable) return null;
  const text = renderReference({ meta, session });
  if (text.length > PROMPT_BUDGET) return null;
  return {
    text,
    mode: "reference",
    markers: [SENTINEL, path.basename(session.nativePath)],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/briefing.test.js`
Expected: PASS, 20 tests

- [ ] **Step 5: Commit**

```bash
git add lib/briefing.js test/briefing.test.js
git commit -m "feat: pick the handoff mode by measuring the assembled prompt"
```

---

### Task 8: `readScreen` returns raw text

**Files:**

- Modify: `lib/handoff.js:305` (`normalize`), `lib/handoff.js:356-368` (`readScreen`), and every site that matches against a screen
- Test: `test/handoff.test.js`, `test/fixtures/fake-herdr-session.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `readScreen(call, paneId) -> string | null` returning the CLI's bytes **unchanged**, newlines intact. `flat(text) -> string` collapses whitespace and is applied at each matching site. Exported additionally: `flat`, `readScreenForTest: readScreen`.

**Why this task exists:** `readScreen` currently returns `normalize(out)`, which replaces every run of whitespace with a single space. Measured on live panes, raw captures carry 52 (pi) and 37 (agy) newlines and the normalised strings carry zero. Any rule that looks at line structure is dead on arrival until this changes.

- [ ] **Step 1: Write the failing test**

The fake CLI must be able to emit a screen with real newlines. Check `test/fixtures/fake-herdr-session.js` for how it answers `agent read`; make it echo the contents of the file named by `env.FAKE_SCREEN_FILE` verbatim when that variable is set, still on stdout, still as plain text. Then append to `test/handoff.test.js`:

```js
const { readScreenForTest, flat } = require("../lib/handoff.js");

test("readScreen hands back the screen with its lines intact", () => {
  const screen = "banner line\n\n  ─────❯      ─────\n? for shortcuts\n";
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "screen-")),
    "s.txt",
  );
  fs.writeFileSync(file, screen);

  const env = {
    ...process.env,
    HANDOFF_FAKE_SCRIPT: SCRIPT,
    FAKE_SCREEN_FILE: file,
  };
  const call = (args, opts = {}) =>
    require("../lib/herdr.js").run([SCRIPT, ...args], { env, ...opts });

  const got = readScreenForTest(call, "w1:p1");
  assert.equal(got, screen, "not one newline may be lost on the way in");
  assert.ok(
    got.includes("\n"),
    "this is the guard: no newline means the line rules cannot fire",
  );
});

test("flat collapses whitespace for phrase matching without destroying the source", () => {
  assert.equal(flat("a\n\n  b"), "a b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.js`
Expected: FAIL — `readScreenForTest is not a function`, then once exported, FAIL on the newline assertion because `normalize` strips them

- [ ] **Step 3: Write minimal implementation**

In `lib/handoff.js`:

```js
// Collapse whitespace only where a phrase or marker is being matched. A TUI wraps
// text across lines, so "Session handoff from" can arrive with a newline in the
// middle of it and only flattened text will contain it.
const flat = (text) => String(text || "").replace(/\s+/g, " ");
```

Delete `normalize` and change `readScreen` to `return out;` instead of `return normalize(out);`. Then update every consumer:

- `usable(screen)` — unchanged, it only checks type and length.
- `needsAnswer(screen)` → `matches(flat(tailOf(screen)), NEEDS_ANSWER)`.
- `startingUp` — Task 9 replaces it. For this task make it `matches(flat(tailOf(screen)), NOT_READY)` so the suite stays green.
- `confirmDelivery` and the persistence re-check near `lib/handoff.js:590` — every `screen.includes(normalize(m))` becomes `flat(screen).includes(flat(m))`.
- The failure log at `lib/handoff.js:606` — keep `why.slice(-200)` but wrap in `flat()` so the log stays on one line.
- `shellIsAtPrompt` and anything else reading `foreground_processes` are untouched; they never went through `readScreen`.

Add `flat` and `readScreenForTest: readScreen` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/handoff.test.js`
Expected: PASS. Also run `node --test "test/**/*.test.js"`; `handoff.test.js` will still show failures from Task 4's removal of `snapshot.write`, which Task 10 fixes. No _new_ failures may appear.

- [ ] **Step 5: Commit**

```bash
git add lib/handoff.js test/handoff.test.js test/fixtures/fake-herdr-session.js
git commit -m "fix: stop flattening the target's screen before anything reads it"
```

---

### Task 9: Line-shaped input-box detection

**Files:**

- Modify: `lib/handoff.js:421-460` (the marker block from `c6d1434`)
- Create: `test/fixtures/screens/agy-verifying.txt`, `test/fixtures/screens/claude-idle.txt`, `test/fixtures/screens/grok-idle.txt`, `test/fixtures/screens/codex-trust.txt`
- Test: `test/handoff.test.js`

**Interfaces:**

- Consumes: `flat` (Task 8).
- Produces: `inputLineIndex(lines) -> number` (index into `lines`, or `-1`) and `startingUp(screen) -> boolean`, both exported. `PROMPT_MARKERS` and `textAfterLastPrompt` from `c6d1434` are removed.

**Fixture contents.** Write these files with exactly these bytes — they are real captures, and a friendlier fixture is precisely the bug this task removes.

`agy-verifying.txt`:

```
⚠️Verifying your account...
 └ We're finishing verifying your account eligibility.
   This usually takes a moment. Please try again shortly.

────────────────────────────────────────────
>
────────────────────────────────────────────
? for shortcuts       Gemini 3.6 Flash · low
```

`claude-idle.txt`:

```



───────────────────────────❯                          ───────────────────────────

  ⏸ manual mode on · ← 1 …
```

`grok-idle.txt` — one single line, no newline anywhere, exactly as the CLI delivered it:

```
                             ≡ main ~\Claude Code                                  New worktree     ctrl+w    Resume session   ctrl+s    Changelog                  Quit             ctrl+q                               Grok 4.5 is here, try      it out for free for a…                                [Click here to Upgrade]                               Tip: Use Ctrl+O or         click [Click here to       Upgrade] to subscribe.                                ╭─────────────────────╮    │ >                   │    ╰─ Grok 4.5 (medium) ─╯                             Grok Build  0.2.112 [stab
```

`codex-trust.txt`:

```
  directory allows
  project-local config,
  hooks, and exec policies
  to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
```

- [ ] **Step 1: Write the failing test**

Append to `test/handoff.test.js`:

```js
const { inputLineIndex } = require("../lib/handoff.js");

const SCREENS = path.join(__dirname, "fixtures", "screens");
// Every fixture reaches startingUp the way production does: through readScreen,
// driven by the fake CLI. A literal in this file could carry newlines the real
// CLI never delivers, which is exactly how the previous rule looked tested.
function screen(name) {
  const file = path.join(SCREENS, name);
  const env = {
    ...process.env,
    HANDOFF_FAKE_SCRIPT: SCRIPT,
    FAKE_SCREEN_FILE: file,
  };
  const call = (args, opts = {}) =>
    require("../lib/herdr.js").run([SCRIPT, ...args], { env, ...opts });
  return readScreenForTest(call, "w1:p1");
}

test("every screen fixture arrives with the bytes its file holds", () => {
  for (const name of [
    "agy-verifying.txt",
    "claude-idle.txt",
    "grok-idle.txt",
    "codex-trust.txt",
  ]) {
    assert.equal(
      screen(name),
      fs.readFileSync(path.join(SCREENS, name), "utf8"),
      `${name} was altered on the way in`,
    );
  }
});

test("Antigravity's account banner above its input line is history, not current state", () => {
  assert.equal(
    startingUp(screen("agy-verifying.txt")),
    false,
    "the notice sits above a drawn input box; the agent is waiting for input",
  );
});

test("a notice with no input box anywhere is current state", () => {
  const noBox =
    "⚠️Verifying your account...\n └ We're finishing verifying your account eligibility.\n";
  const file = path.join(SCREENS, "tmp-nobox.txt");
  fs.writeFileSync(file, noBox);
  try {
    assert.equal(startingUp(screen("tmp-nobox.txt")), true);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("Claude Code's prompt drawn inside a border line is found", () => {
  const lines = screen("claude-idle.txt").split("\n");
  const i = inputLineIndex(lines);
  assert.ok(i >= 0, "───────❯──────── is an input line");
  assert.ok(lines[i].includes("❯"));
});

test("Grok's box-drawn prompt is found when the capture has lines", () => {
  assert.ok(
    inputLineIndex(["╭─────────╮", "│ >       │", "╰─ Grok ──╯"]) === 1,
  );
});

test("a capture with no newlines falls back to the character tail rather than guessing", () => {
  const raw = screen("grok-idle.txt");
  assert.ok(
    !raw.includes("\n"),
    "this is what the CLI actually returns for Grok",
  );
  assert.equal(
    inputLineIndex(raw.split("\n")),
    -1,
    "one line: nothing to reason about",
  );
  assert.equal(startingUp(raw), false, "and its tail holds no startup phrase");
});

test("a startup notice below the input line still counts", () => {
  const lines = ["> ", "────────────", "Signing in to your account…"];
  assert.equal(
    startingUp(lines.join("\n")),
    true,
    "a footer notice is current state, unlike a banner above the box",
  );
});

test("Codex's trust dialog is a question, and questions are never typed into", () => {
  assert.equal(needsAnswer(screen("codex-trust.txt")), true);
});

test("prose containing a quoted line is not mistaken for an input box", () => {
  const lines = [
    "> the previous agent wrote this in a markdown blockquote",
    "and then twelve more lines of ordinary output followed",
    "line 3",
    "line 4",
    "line 5",
    "line 6",
    "line 7",
    "line 8",
    "line 9",
    "line 10",
    "Signing in to your account…",
  ];
  assert.equal(
    startingUp(lines.join("\n")),
    true,
    "the quote is far above the bottom and must not shield the notice",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.js`
Expected: FAIL — `inputLineIndex is not a function`

- [ ] **Step 3: Write minimal implementation**

Replace the `c6d1434` block in `lib/handoff.js` with:

```js
// An agent's input box means it is waiting for input, so a startup notice drawn
// *above* it is scrollback and a notice *below* it is current state. Antigravity
// leaves "Verifying your account…" on screen long after it stops being true, and
// matching the whole capture left the target permanently "starting up".
//
// Detection has to be line-shaped and border-tolerant, because the marker is
// usually not the first character: Claude Code draws "───────❯        ───────"
// and Grok draws "│ >                   │". Only the bottom of the screen is
// considered, so a markdown blockquote in the agent's own output cannot pose as
// an input box.
const CURRENT_VIEW_CHARS = 400;
const TAIL_LINES = 8;
const PROMPT_GLYPHS = [">", "❯", "›", "▶", "»", "⏵", "$", "%", "#"];
const BORDER =
  /^[\s\u2500-\u257f\u2580-\u259f\u2022\u00b7]+|[\s\u2500-\u257f\u2580-\u259f\u2022\u00b7]+$/g;

const tailOf = (screen) =>
  typeof screen === "string" ? screen.slice(-CURRENT_VIEW_CHARS) : screen;

function inputLineIndex(lines) {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < TAIL_LINES; i -= 1) {
    const core = lines[i].replace(BORDER, "");
    if (core === "") continue;
    seen += 1;
    if (PROMPT_GLYPHS.some((g) => core.startsWith(g))) return i;
  }
  return -1;
}

function startingUp(screen) {
  if (typeof screen !== "string" || screen === "") return false;
  const lines = screen.split("\n");
  const i = inputLineIndex(lines);
  // No box found — including a capture with no newlines at all, which is what
  // Grok returns — keeps the character tail. Unknown agents therefore degrade to
  // the previous behaviour rather than breaking.
  if (i === -1) return matches(flat(tailOf(screen)), NOT_READY);
  return matches(flat(lines.slice(i).join("\n")), NOT_READY);
}
```

Add `inputLineIndex` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/handoff.test.js`
Expected: PASS for all nine new tests

- [ ] **Step 5: Commit**

```bash
git add lib/handoff.js test/handoff.test.js test/fixtures/screens
git commit -m "fix: tell a startup banner above the input box from live state below it"
```

---

### Task 10: Wire the orchestrator to prompt-only delivery

**Files:**

- Modify: `lib/handoff.js:766-792` (snapshot + `HANDOFF.md`), `lib/handoff.js:835-852` (delivery), `lib/handoff.js:884` (return)
- Modify: `lib/paths.js` (drop `handoffsDir`)
- Test: `test/handoff.test.js`, `test/paths.test.js`

**Interfaces:**

- Consumes: `snapshot.measure` (Task 4), `briefing.build` (Task 7).
- Produces: `run()` returns `{ ok, message, prompt, mode, targetPaneId, agentName }` on success. `handoffDir` is gone from every return path. `dryRun` returns `{ ok: true, message: "", prompt, mode, request, meta }`.

- [ ] **Step 1: Write the failing test**

In `test/handoff.test.js`, replace every assertion that reads `result.handoffDir`, opens `HANDOFF.md`, or inspects a handoffs directory. Add:

```js
test("a handoff writes nothing to disk and carries the session in the prompt", async () => {
  const { env, home } = workspace({ agent: "pi", lines: 3 });
  const result = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "inline");
  assert.match(result.prompt, /^You are taking over this session from/);
  assert.equal(
    result.handoffDir,
    undefined,
    "there is no handoff directory any more",
  );

  const state = path.join(home, "state");
  const stray = fs.existsSync(path.join(state, "handoffs"));
  assert.equal(stray, false, "no handoffs directory may be created");
});

test("the prompt the target receives is the prompt that was built", async () => {
  const { env } = workspace({ agent: "pi", lines: 3 });
  const result = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  const sent = readSentPrompts(env); // whatever helper this file already uses to read
  assert.equal(sent.length, 1, "exactly once"); // what the fake CLI recorded
  assert.equal(sent[0], result.prompt);
});

test("an over-budget unreadable source reports that full context is unavailable", async () => {
  const { env } = workspace({
    agent: "pi",
    binarySession: true,
    bytes: 400_000,
  });
  const result = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, MESSAGES.noContext);
});
```

Extend the `workspace()` helper with `binarySession` and `bytes` options so it can write a large session containing a NUL byte. In `test/paths.test.js`, replace the `handoffsDir` test with one asserting `paths.handoffsDir === undefined`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.js`
Expected: FAIL — `snapshot.write is not a function` from Task 4, and the new assertions

- [ ] **Step 3: Write minimal implementation**

In `lib/handoff.js`, replace step 5 and the `HANDOFF.md` write with:

```js
// 5. Measure the session, re-resolving so the capture is as fresh as possible.
//    Nothing is written: the transcript either travels inside the prompt or is
//    read by the target from where its own agent put it.
let session;
try {
  resolved = resolveSource();
  session = snapshot.measure({ resolved });
} catch (err) {
  const message =
    err instanceof SqliteUnavailable && /node:sqlite/.test(err.message)
      ? MESSAGES.needsNode225
      : MESSAGES.noContext;
  notify(call, message);
  return { ok: false, message };
}

meta.snapshotUtc = new Date().toISOString();
const built = briefing.build({ meta, session });
if (!built) {
  notify(call, MESSAGES.noContext);
  return { ok: false, message: MESSAGES.noContext };
}

if (dryRun) {
  return {
    ok: true,
    message: "",
    prompt: built.text,
    mode: built.mode,
    request,
    meta,
  };
}
```

Delete the `handoffsDir` mkdir, the `handoffPath` write, the `chmodSync`, and the `snapshot.prune` call. Change the delivery call to pass `built.text` and `built.markers`:

```js
await deliverPrompt(call, targetPaneId, built.text, env, built.markers, {
  onSlow: () => notify(call, MESSAGES.startingUp(targetName)),
  onAttention: () => notify(call, MESSAGES.needsAttention(targetName)),
});
```

Replace `handoffDir: snap.dir` with `prompt: built.text, mode: built.mode` in the three remaining return statements, and drop `handoffsDir` from `lib/paths.js` and its export list.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add lib/handoff.js lib/paths.js test/handoff.test.js test/paths.test.js
git commit -m "feat: deliver the handoff as a prompt and write nothing to disk"
```

---

### Task 11: The one opencode exception

**Files:**

- Modify: `lib/handoff.js` (the `briefing.build` block from Task 10)
- Test: `test/handoff.test.js`

**Interfaces:**

- Consumes: `exportPathFor` (Task 3), `briefing.build` (Task 7).
- Produces: no new exports. When `session.strategy === "sqlite"` and `build` chose reference mode, the rows are written to `exportPathFor(dbPath, sessionId)` and the prompt is rebuilt with `nativePath` pointing there.

**Why:** opencode's store is a single 304 MiB database with no per-session files, verified on this machine. Above the inline budget its rows have to be materialised somewhere. One file, in opencode's own data directory, overwritten per session so it never accumulates.

- [ ] **Step 1: Write the failing test**

```js
test("a large opencode session is exported once, beside its own database", async () => {
  const { env, dbPath, sessionId } = opencodeWorkspace({ rows: 4000 }); // existing helper style
  const result = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "reference");

  const exported = path.join(
    path.dirname(dbPath),
    `herdr-handoff-${sessionId}.jsonl`,
  );
  assert.ok(fs.existsSync(exported), "the one documented exception");
  assert.ok(result.prompt.includes(exported), "and the prompt points at it");
  assert.ok(
    !result.prompt.includes("opencode.db"),
    "never at the database itself",
  );
});

test("handing off the same opencode session twice leaves one file, not two", async () => {
  const { env, dbPath, sessionId } = opencodeWorkspace({ rows: 4000 });
  await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });

  const dir = path.dirname(dbPath);
  const ours = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("herdr-handoff-"));
  assert.deepEqual(
    ours,
    [`herdr-handoff-${sessionId}.jsonl`],
    "overwritten, never accumulated",
  );
});

test("a small opencode session is inlined and writes nothing at all", async () => {
  const { env, dbPath } = opencodeWorkspace({ rows: 3 });
  const result = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(result.mode, "inline");
  const ours = fs
    .readdirSync(path.dirname(dbPath))
    .filter((f) => f.startsWith("herdr-handoff-"));
  assert.deepEqual(ours, [], "under budget, opencode gets no exception either");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.js`
Expected: FAIL — the export file does not exist and the prompt names `opencode.db`

- [ ] **Step 3: Write minimal implementation**

In `lib/handoff.js`, after `built` is computed and before the `dryRun` return:

```js
// opencode's only store is a single database with no per-session files, so a
// session too large to inline has to be materialised. This is the one place the
// plugin writes anything. One file, named for the session, in opencode's own
// data directory, overwritten on each handoff of that session.
let delivered = built;
if (built.mode === "reference" && session.strategy === "sqlite") {
  const exportPath = exportPathFor(resolved.dbPath, resolved.sessionId);
  try {
    fs.writeFileSync(exportPath, session.body);
  } catch (err) {
    log(`opencode export failed: ${describeError(err)}`);
    notify(call, MESSAGES.noContext);
    return { ok: false, message: MESSAGES.noContext };
  }
  delivered = briefing.build({
    meta,
    session: { ...session, nativePath: exportPath },
  });
  if (!delivered) {
    notify(call, MESSAGES.noContext);
    return { ok: false, message: MESSAGES.noContext };
  }
}
```

Use `delivered.text`, `delivered.mode` and `delivered.markers` from here on. Add `exportPathFor` to the `require` of `./source-sqlite.js` at `lib/handoff.js:16`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/**/*.test.js"`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add lib/handoff.js test/handoff.test.js
git commit -m "feat: export a large opencode session beside its own database, once"
```

---

### Task 12: README

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the documentation**

Rewrite the sections describing the handoff package. State:

- The handoff travels entirely inside the prompt. There is no `HANDOFF.md`, no snapshot directory, no `SOURCE.json`.
- Sessions that fit inside the ~30,000-character prompt budget are delivered inline, and nothing is written anywhere.
- Larger sessions are delivered as a reference: the prompt names the source agent's own transcript, its line count and SHA-256 as of handoff, and the ordered ranges to read. The target is told not to read past the pinned last line, because that file is still live.
- Some agents will ask permission to read a path outside the project. Allow it once, or run the agent in a permissive mode.
- The single exception: an opencode session too large to inline is exported to `herdr-handoff-<session>.jsonl` beside `opencode.db`, overwritten per session, because opencode stores everything in one database with no per-session files.
- Remove any mention of pruning, the 20-snapshot limit, or read-only handoff directories.

- [ ] **Step 2: Verify the claims**

Run: `git grep -n "HANDOFF.md\|SOURCE.json\|prune" -- README.md lib/`
Expected: no hits outside `docs/`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the prompt-only handoff"
```

---

### Task 13: Live verification against the installed agents

**Files:**

- Create: `scratch/live-prompt-handoff.js` (throwaway, not committed)

**This task cannot be completed by reasoning. It has to be run.** Seven agents are installed: `pi`, `claude`, `codex`, `grok`, `hermes`, `opencode`, `agy`.

- [ ] **Step 1: Confirm the Herdr server is up**

Run: `herdr status`
Expected: `running`. If not, the user has to start Herdr; nothing below works without it.

- [ ] **Step 2: Verify an inline handoff end to end**

From a small source session (under budget), hand off to `pi` and to `claude`. For each, record: whether the sentinel `-- end of handoff, begin now --` appears on the target's screen, the time to delivery, and whether the agent began work without being asked twice.

- [ ] **Step 3: Settle the open risk in the spec — paste collapsing**

This is the one thing the design could not decide in advance. Hand off a session close to the budget (roughly 25,000–29,000 characters) to each of `pi`, `claude`, `codex`, `grok`, `hermes`, `agy` and read the target's screen after submission.

If a target shows a placeholder such as `[Pasted text #1 +612 lines]` instead of echoing the prompt, the sentinel will not be found and a delivered handoff would be reported as failed. If that happens for any agent, add a second accepted proof to `confirmDelivery` for inline mode only: a paste-placeholder pattern (`/\[pasted text/i`, `/\+\d+ lines/i`). Do **not** fall back to "the screen changed" or "the agent changed state"; both were tried on this branch and both announced handoffs that had not been delivered. Record what each agent did in the spec's section 3.1 in place of the "open risk" note.

- [ ] **Step 4: Verify a reference handoff end to end**

From a large source session — this repo's own Claude session is 13.8 MB, and `~/.codex/sessions` has several files over 4 MB — hand off to `claude` and `codex`. Confirm the prompt is under 32,767 characters, the target opens the named file, and it does not read past the pinned line.

- [ ] **Step 5: Verify the opencode exception**

Hand off a large opencode session. Confirm exactly one `herdr-handoff-*.jsonl` appears beside `opencode.db`, that a second handoff of the same session does not add another, and — the assumption the spec flags — whether opencode asks permission to read a file inside its own data directory. Record the answer in the spec.

- [ ] **Step 6: Verify agy specifically**

agy is the agent whose readiness rule this work replaced. Confirm it still delivers, and that `startingUp` returns `false` for its settled screen exactly as it did before the change.

- [ ] **Step 7: Full suite and commit any fixes**

Run: `node --test "test/**/*.test.js"`
Expected: every test passing. Commit any fix this task produced with a message naming the agent and the observed behaviour that motivated it.

---

## Self-Review

**Spec coverage:**

| spec section                         | task                           |
| ------------------------------------ | ------------------------------ |
| 2.1 prompt ceiling / budget          | Global constraints, Task 7     |
| 2.2 session sizes drive mode choice  | Task 7                         |
| 2.3 opencode has no per-session file | Task 11                        |
| 3.1 anatomy, budget, sentinel marker | Tasks 5, 6, 7                  |
| 3.1 open risk: paste collapsing      | Task 13 step 3                 |
| 3.2 inline mode                      | Task 5                         |
| 3.3 reference mode, pinned N, ranges | Tasks 1, 6                     |
| 3.3 readability gate                 | Tasks 2, 7                     |
| 4 opencode exception                 | Tasks 3, 11                    |
| 5.1 readScreen returns raw           | Task 8                         |
| 5.3 line-shaped detection            | Task 9                         |
| 5.4 safe for agents working today    | Task 9 tests, Task 13 step 6   |
| 6 module changes                     | Tasks 3, 4, 5, 6, 7, 10, 12    |
| 7 errors                             | Tasks 7, 10, 11                |
| 8 testing                            | every task; fixtures in Task 9 |
| 9 limitations                        | Task 12 (README)               |

**Placeholder scan:** none. Every code step carries the code; every test step carries the assertions. Task 12 is prose-only by nature and lists the exact claims to make. Task 13 is a live procedure with recorded outcomes and one explicit decision point.

**Type consistency:** `measure()` returns `{ strategy, nativePath, body, bytes, lines, sha256, counts, readable }` and Tasks 5, 6, 7, 10 and 11 all read those names. `build()` returns `{ text, mode, markers }` or `null`, consumed only in Tasks 10 and 11. `ranges()` returns `{ list, truncated, perRange, total }`, consumed only in Task 6. `extractToBuffer` returns `{ body, lines, bytes, counts, opened }`, consumed in Tasks 3 and 4.

**One known ordering cost:** Task 4 removes `snapshot.write` while `handoff.js` still calls it, so the full suite is red between Task 4 and Task 10. Each task's own file stays green throughout, and Task 10 restores the whole suite. This is called out in Tasks 4, 8 and 10 so nobody mistakes it for a regression.
