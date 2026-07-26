"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { measure, isReadableText, READABLE_PROBE_BYTES } = require("../lib/snapshot.js");

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
  assert.equal(m.sha256, crypto.createHash("sha256").update(contents).digest("hex"));
  assert.equal(m.readable, true);
  assert.equal(m.counts, null);
  assert.equal(m.body.toString("utf8"), contents, "the body is the file byte for byte");
  assert.deepEqual(fs.readdirSync(dir), before, "measuring writes nothing");
});

test("a final line without a trailing newline still counts", () => {
  const { file } = tempFile('{"n":1}\n{"n":2}');
  assert.equal(measure({ resolved: { strategy: "file", path: file } }).lines, 2);
});

test("an unreadable native file is measured but flagged, not thrown on", () => {
  const { file } = tempFile(Buffer.from([0x00, 0x01, 0x02]));
  const m = measure({ resolved: { strategy: "file", path: file } });
  assert.equal(m.readable, false, "the caller decides what to do about it");
});

test("measure no longer offers the copying API", () => {
  const snapshot = require("../lib/snapshot.js");
  for (const gone of ["write", "prune", "chunk"]) {
    assert.equal(snapshot[gone], undefined, `${gone} should be gone: nothing is copied any more`);
  }
});
