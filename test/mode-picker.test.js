"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PICKER = path.join(__dirname, "..", "bin", "mode-picker.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-mode-"));
  const resultPath = path.join(dir, "r.result.json");
  const requestPath = path.join(dir, "r.request.json");
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      resultPath,
      contextLine: "pi in Herdr · tab 1 · 112 lines",
      theme: null,
    }),
  );
  return { dir, requestPath, resultPath };
}

function runPicker(requestPath, keys, extraEnv = {}) {
  return spawnSync(process.execPath, [PICKER], {
    input: keys.join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      HERDR_HANDOFF_REQUEST: requestPath,
      HANDOFF_PICKER_HEADLESS: "1",
      ...extraEnv,
    },
  });
}

test("enter selects the default focused mode", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["enter"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    mode: "focused",
  });
});

test("down then enter selects the full transcript", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["down", "enter"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    mode: "full",
  });
});

test("digits select directly", () => {
  const first = setup();
  const firstRes = runPicker(first.requestPath, ["1"]);
  assert.equal(firstRes.status, 0, firstRes.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.resultPath, "utf8")), {
    mode: "focused",
  });

  const second = setup();
  const res = runPicker(second.requestPath, ["2"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(second.resultPath, "utf8")), {
    mode: "full",
  });
});

test("escape writes a cancellation", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["escape"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    cancelled: true,
  });
});

test("stdin closing without a choice writes a cancellation", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, []);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    cancelled: true,
  });
});

test("the rendered frame shows both modes and the default", () => {
  const { requestPath } = setup();
  const res = runPicker(requestPath, ["enter"]);
  assert.match(res.stdout, /Focused handoff/);
  assert.match(res.stdout, /Full session transcript/);
  assert.match(res.stdout, /default/i);
  assert.match(res.stdout, /pi in Herdr · tab 1/);
});

test("a missing request file exits non-zero", () => {
  const res = spawnSync(process.execPath, [PICKER], {
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      HERDR_HANDOFF_REQUEST: path.join(os.tmpdir(), "nope-mode.json"),
      HANDOFF_PICKER_HEADLESS: "1",
    },
  });
  assert.notEqual(res.status, 0);
});
