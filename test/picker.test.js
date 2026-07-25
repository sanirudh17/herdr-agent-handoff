const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PICKER = path.join(__dirname, "..", "bin", "picker.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-pick-"));
  const resultPath = path.join(dir, "r.result.json");
  const requestPath = path.join(dir, "r.request.json");
  fs.writeFileSync(requestPath, JSON.stringify({
    resultPath,
    contextLine: "pi · w5:p1 · 4,812 lines  →  split beside w5:p1",
    available: [
      { kind: "claude", name: "Claude Code", isSource: false },
      { kind: "codex", name: "Codex", isSource: false },
      { kind: "pi", name: "pi", isSource: true },
    ],
    unavailable: [{ kind: "gemini", name: "Gemini CLI (deprecated)" }],
    unavailableCount: 18,
  }));
  return { dir, requestPath, resultPath };
}

function runPicker(requestPath, keys) {
  return spawnSync(process.execPath, [PICKER], {
    input: keys.join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      HERDR_HANDOFF_REQUEST: requestPath,
      HANDOFF_PICKER_HEADLESS: "1",
    },
  });
}

test("selecting with enter writes the chosen kind", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["down", "enter"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), { selected: "codex" });
});

test("selecting the source agent is allowed", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["3"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), { selected: "pi" });
});

test("escape writes a cancellation", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["escape"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), { cancelled: true });
});

test("stdin closing without a choice writes a cancellation", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, []);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), { cancelled: true });
});

test("the rendered frame contains the title and roster", () => {
  const { requestPath } = setup();
  const res = runPicker(requestPath, ["enter"]);
  assert.match(res.stdout, /Handoff to Agent/);
  assert.match(res.stdout, /Claude Code/);
  assert.match(res.stdout, /3 \/ 21 available/);
});

test("a missing request file exits non-zero", () => {
  const res = spawnSync(process.execPath, [PICKER], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, HERDR_HANDOFF_REQUEST: path.join(os.tmpdir(), "nope.json"), HANDOFF_PICKER_HEADLESS: "1" },
  });
  assert.notEqual(res.status, 0);
});
