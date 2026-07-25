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

test("stripVerbatim removes the Windows \\\\?\\ prefix", () => {
  assert.equal(paths.stripVerbatim("\\\\?\\C:\\Users\\sanir\\Herdr plugin"), "C:\\Users\\sanir\\Herdr plugin");
});

test("stripVerbatim leaves ordinary paths untouched", () => {
  assert.equal(paths.stripVerbatim("C:\\Users\\sanir"), "C:\\Users\\sanir");
  assert.equal(paths.stripVerbatim("/home/u/plugin"), "/home/u/plugin");
  assert.equal(paths.stripVerbatim(""), "");
  assert.equal(paths.stripVerbatim(undefined), "");
});

test("pluginRoot returns HERDR_PLUGIN_ROOT with the verbatim prefix stripped", () => {
  assert.equal(
    paths.pluginRoot({ HERDR_PLUGIN_ROOT: "\\\\?\\C:\\p" }),
    "C:\\p"
  );
});

test("pluginRoot falls back to cwd when the env var is absent", () => {
  assert.equal(paths.pluginRoot({}), paths.stripVerbatim(process.cwd()));
});

test("handoffsDir and requestsDir sit under stateDir", () => {
  const dir = path.join(path.sep, "tmp", "state");
  const env = { HERDR_PLUGIN_STATE_DIR: dir };
  assert.equal(paths.handoffsDir(env), path.join(dir, "handoffs"));
  assert.equal(paths.requestsDir(env), path.join(dir, "requests"));
});
