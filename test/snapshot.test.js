const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chunk, write, prune } = require("../lib/snapshot.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-snap-"));
}

const META = {
  sourceKind: "pi", sourceName: "pi", sessionId: "abc", sourcePaneId: "w5:p1",
  workspaceId: "w5", tabId: "w5:t1", cwd: "/w", destination: "tab",
  targetKind: "claude", targetName: "Claude Code",
};

test("chunk splits on line boundaries and reassembles byte-for-byte", () => {
  const body = Buffer.from("a\nb\nc\nd\ne\n");
  const parts = chunk(body, { maxLines: 2, maxBytes: 1024 });
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.lines), [2, 2, 1]);
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk respects the byte cap even when the line cap is not reached", () => {
  const body = Buffer.from("aaaa\nbbbb\ncccc\n");
  const parts = chunk(body, { maxLines: 1000, maxBytes: 6 });
  assert.ok(parts.length >= 3);
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk handles a final line with no trailing newline", () => {
  const body = Buffer.from("a\nb");
  const parts = chunk(body, { maxLines: 1, maxBytes: 1024 });
  assert.deepEqual(parts.map((p) => p.lines), [1, 1]);
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk handles a single line", () => {
  const body = Buffer.from("only\n");
  const parts = chunk(body, { maxLines: 1200, maxBytes: 1024 });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].lines, 1);
});

test("chunk handles an exact boundary without emitting an empty part", () => {
  const body = Buffer.from("a\nb\n");
  const parts = chunk(body, { maxLines: 2, maxBytes: 1024 });
  assert.equal(parts.length, 1);
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk returns nothing for an empty buffer", () => {
  assert.deepEqual(chunk(Buffer.alloc(0)), []);
});

test("write produces parts that reassemble into the original file", () => {
  const home = tmp();
  const src = path.join(home, "session.jsonl");
  const body = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n";
  fs.writeFileSync(src, body);

  const base = tmp();
  const out = write({
    resolved: { strategy: "file", path: src, bytes: Buffer.byteLength(body), lines: 3000 },
    meta: META, baseDir: base, now: new Date("2026-07-25T12:00:00Z"),
  });

  assert.ok(out.parts.length >= 3, "3000 lines should exceed one 1200-line part");
  const joined = Buffer.concat(out.parts.map((p) => fs.readFileSync(p.file)));
  assert.deepEqual(joined, Buffer.from(body));
  assert.equal(out.totalLines, 3000);
  assert.equal(out.sha256, crypto.createHash("sha256").update(body).digest("hex"));
});

test("write records contiguous part line ranges summing to the total", () => {
  const home = tmp();
  const src = path.join(home, "s.jsonl");
  const body = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") + "\n";
  fs.writeFileSync(src, body);
  const base = tmp();
  const out = write({
    resolved: { strategy: "file", path: src, bytes: Buffer.byteLength(body), lines: 2500 },
    meta: META, baseDir: base,
  });

  let expected = 1;
  let sum = 0;
  for (const part of out.parts) {
    assert.equal(part.firstLine, expected);
    assert.equal(part.lastLine, expected + part.lines - 1);
    expected = part.lastLine + 1;
    sum += part.lines;
  }
  assert.equal(sum, out.totalLines);
});

test("write emits SOURCE.json with the metadata and part index", () => {
  const home = tmp();
  const src = path.join(home, "s.jsonl");
  fs.writeFileSync(src, "a\nb\n");
  const base = tmp();
  const out = write({
    resolved: { strategy: "file", path: src, bytes: 4, lines: 2 },
    meta: META, baseDir: base,
  });
  const source = JSON.parse(fs.readFileSync(path.join(out.dir, "SOURCE.json"), "utf8"));
  assert.equal(source.source_agent, "pi");
  assert.equal(source.strategy, "file");
  assert.equal(source.native_path, src);
  assert.equal(source.total_lines, 2);
  assert.equal(source.parts.length, out.parts.length);
  assert.equal(source.source_pane_id, "w5:p1");
});

test("write marks the snapshot read-only", () => {
  const home = tmp();
  const src = path.join(home, "s.jsonl");
  fs.writeFileSync(src, "a\n");
  const base = tmp();
  const out = write({
    resolved: { strategy: "file", path: src, bytes: 2, lines: 1 }, meta: META, baseDir: base,
  });
  if (process.platform !== "win32") {
    const mode = fs.statSync(out.parts[0].file).mode & 0o777;
    assert.equal(mode, 0o444);
  } else {
    assert.throws(
      () => fs.writeFileSync(out.parts[0].file, "clobber"),
      "a read-only part must not be writable"
    );
  }
});

const { isReadableText, READABLE_PROBE_BYTES } = require("../lib/snapshot.js");

test("line-oriented UTF-8 text is readable", () => {
  const body = Buffer.from('{"a":1}\n{"a":2}\n', "utf8");
  assert.equal(isReadableText(body), true);
});

test("a NUL byte means it is not text a target can read", () => {
  const body = Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0x00]), Buffer.from("more\n")]);
  assert.equal(isReadableText(body), false);
});

test("invalid UTF-8 is not readable", () => {
  // 0xC3 starts a two-byte sequence; 0x28 cannot continue it.
  const body = Buffer.concat([Buffer.from([0xc3, 0x28]), Buffer.from("\n")]);
  assert.equal(isReadableText(body), false);
});

test("text with no newline at all is not line-oriented", () => {
  assert.equal(isReadableText(Buffer.from("one single line, no terminator", "utf8")), false);
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

test("prune keeps the newest directories and removes the rest", () => {
  const base = tmp();
  for (const name of ["a", "b", "c", "d"]) {
    fs.mkdirSync(path.join(base, name), { recursive: true });
    fs.writeFileSync(path.join(base, name, "x"), "x");
  }
  const removed = prune(base, 2);
  assert.equal(removed.length, 2);
  assert.equal(fs.readdirSync(base).length, 2);
});
