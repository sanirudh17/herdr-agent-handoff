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
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      resultPath,
      contextLine: "pi in Herdr · tab 1 · 4,812 lines",
      destination: "split beside it",
      installed: [
        { kind: "claude", name: "Claude Code", isSource: false },
        { kind: "codex", name: "Codex", isSource: false },
        { kind: "pi", name: "pi", isSource: true },
      ],
      notInstalled: Array.from({ length: 18 }, (_, i) => ({
        kind: `u${i}`,
        name: `Unavailable ${i}`,
      })),
    }),
  );
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
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    selected: "codex",
  });
});

test("selecting the source agent is allowed", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["3"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    selected: "pi",
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

test("the rendered frame shows the roster, counter and place labels", () => {
  const { requestPath } = setup();
  const res = runPicker(requestPath, ["enter"]);
  assert.match(res.stdout, /Claude Code/);
  assert.match(res.stdout, /3 \/ 21 available/);
  assert.match(res.stdout, /pi in Herdr · tab 1/);
  assert.match(res.stdout, /split beside it/);
  assert.ok(
    !res.stdout.includes("Handoff to Agent"),
    "the popup border already carries the title",
  );
  assert.ok(!/w\d+:[pt]\d+/.test(res.stdout), "no raw pane ids");
});

test("tab reaches the not-installed roster inside the real picker", () => {
  const { requestPath } = setup();
  const res = runPicker(requestPath, ["tab", "pagedown", "pagedown", "escape"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(
    res.stdout,
    /Unavailable 17/,
    "the last missing agent must be reachable",
  );
});

test("a missing request file exits non-zero", () => {
  const res = spawnSync(process.execPath, [PICKER], {
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      HERDR_HANDOFF_REQUEST: path.join(os.tmpdir(), "nope.json"),
      HANDOFF_PICKER_HEADLESS: "1",
    },
  });
  assert.notEqual(res.status, 0);
});
