const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { run, binPath, HerdrCliError } = require("../lib/herdr.js");

const FAKE = path.join(__dirname, "fixtures", "fake-herdr.js");
// The fake is a .js file, so invoke node and let the first arg be the script.
const fakeEnv = { HERDR_BIN_PATH: process.execPath };

test("binPath falls back to herdr", () => {
  assert.equal(binPath({}), "herdr");
  assert.equal(binPath({ HERDR_BIN_PATH: "/opt/herdr" }), "/opt/herdr");
});

test("run returns the result payload and passes argv through", () => {
  const out = run([FAKE, "pane", "get", "w1:p1"], { env: fakeEnv });
  assert.equal(out.type, "echo");
  assert.deepEqual(out.args, ["pane", "get", "w1:p1"]);
});

test("run throws HerdrCliError carrying the envelope code and message", () => {
  assert.throws(
    () => run([FAKE, "fail-envelope"], { env: fakeEnv }),
    (err) => {
      assert.ok(err instanceof HerdrCliError);
      assert.equal(err.code, "pane_not_found");
      assert.match(err.message, /pane w99:p99 not found/);
      return true;
    },
  );
});

test("run tolerates a UTF-8 BOM on the response", () => {
  const out = run([FAKE, "bom"], { env: fakeEnv });
  assert.equal(out.type, "echo");
});

test("run throws on non-zero exit with unparseable output", () => {
  assert.throws(
    () => run([FAKE, "fail-garbage"], { env: fakeEnv }),
    HerdrCliError,
  );
});

test("run throws when json is expected but output is not JSON", () => {
  assert.throws(
    () => run([FAKE, "ok-garbage"], { env: fakeEnv }),
    HerdrCliError,
  );
});

test("run with json:false returns raw stdout", () => {
  const out = run([FAKE, "plain"], { env: fakeEnv, json: false });
  assert.match(out, /^Config: /);
});

// Not every Herdr command answers with a JSON envelope. `agent read` prints the
// screen as plain text and `pane run` prints nothing at all; asking either for
// JSON throws. That mistake, made against `agent read`, silently disabled the
// delivery check for every handoff.
test("a plain-text command throws when JSON is demanded, so callers must opt out", () => {
  assert.throws(
    () => run([FAKE, "plain"], { env: fakeEnv }),
    /returned no JSON result/,
    "demanding JSON from a text command must fail loudly, not return empty",
  );
});

test("run throws when the binary cannot be executed", () => {
  assert.throws(
    () =>
      run(["x"], {
        env: { HERDR_BIN_PATH: path.join(__dirname, "no-such-binary-xyz") },
      }),
    HerdrCliError,
  );
});
