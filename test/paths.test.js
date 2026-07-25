const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const paths = require("../lib/paths.js");

test("stateDir prefers HERDR_PLUGIN_STATE_DIR", () => {
  const dir = path.join(path.sep, "tmp", "state");
  assert.equal(paths.stateDir({ HERDR_PLUGIN_STATE_DIR: dir }), dir);
});

test("stateDir falls back to a cwd-relative dir when env is absent", () => {
  const got = paths.stateDir({});
  assert.ok(path.isAbsolute(got), `expected absolute path, got ${got}`);
});

test("handoffsDir and requestsDir sit under stateDir", () => {
  const dir = path.join(path.sep, "tmp", "state");
  const env = { HERDR_PLUGIN_STATE_DIR: dir };
  assert.equal(paths.handoffsDir(env), path.join(dir, "handoffs"));
  assert.equal(paths.requestsDir(env), path.join(dir, "requests"));
});
