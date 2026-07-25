const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ipc = require("../lib/ipc.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-ipc-"));
}

test("newId produces unique filesystem-safe ids", () => {
  const a = ipc.newId();
  const b = ipc.newId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("request and result paths are derived from the id", () => {
  const dir = tmp();
  const id = "abc123";
  assert.equal(ipc.requestPath(dir, id), path.join(dir, "abc123.request.json"));
  assert.equal(ipc.resultPath(dir, id), path.join(dir, "abc123.result.json"));
});

test("writeJson then readJson round-trips and leaves no temp file", () => {
  const dir = tmp();
  const file = path.join(dir, "x.json");
  ipc.writeJson(file, { hello: "world", n: 1 });
  assert.deepEqual(ipc.readJson(file), { hello: "world", n: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["x.json"]);
});

test("waitForResult returns the payload once it appears", async () => {
  const dir = tmp();
  const file = path.join(dir, "r.json");
  setTimeout(() => ipc.writeJson(file, { selected: "claude" }), 40);
  const got = await ipc.waitForResult(file, { timeoutMs: 3000, pollMs: 10 });
  assert.deepEqual(got, { selected: "claude" });
});

test("waitForResult returns null on timeout", async () => {
  const dir = tmp();
  const got = await ipc.waitForResult(path.join(dir, "never.json"), { timeoutMs: 60, pollMs: 10 });
  assert.equal(got, null);
});

test("waitForResult ignores a partially written file until it parses", async () => {
  const dir = tmp();
  const file = path.join(dir, "r.json");
  fs.writeFileSync(file, '{"selected":');
  setTimeout(() => ipc.writeJson(file, { cancelled: true }), 60);
  const got = await ipc.waitForResult(file, { timeoutMs: 3000, pollMs: 10 });
  assert.deepEqual(got, { cancelled: true });
});

test("cleanup removes files and tolerates missing ones", () => {
  const dir = tmp();
  const file = path.join(dir, "a.json");
  ipc.writeJson(file, {});
  ipc.cleanup([file, path.join(dir, "gone.json")]);
  assert.equal(fs.existsSync(file), false);
});
