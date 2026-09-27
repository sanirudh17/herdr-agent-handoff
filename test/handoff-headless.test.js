"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  parseHeadlessArgs,
  resolveHeadlessSource,
  validateHeadless,
} = require("../bin/handoff-headless.js");
const { run } = require("../lib/handoff.js");

const BIN = path.join(__dirname, "..", "bin", "handoff-headless.js");
const SCRIPT = path.join(__dirname, "fixtures", "fake-herdr-session.js");
const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";

// --- arg parsing: additive only, no existing paths touched ---

test("missing --target is invalid even with valid destination/mode", () => {
  assert.equal(
    validateHeadless({ target: null, destination: "split", mode: "focused" }),
    false,
  );
  assert.equal(
    validateHeadless({ target: "", destination: "split", mode: "focused" }),
    false,
  );
});

test("flag-like values are rejected, not swallowed as values", () => {
  assert.equal(
    parseHeadlessArgs(["--target", "--mode", "focused"], {}).target,
    null,
  );
  assert.equal(parseHeadlessArgs(["--target=--mode"], {}).target, null);
  assert.equal(
    validateHeadless(parseHeadlessArgs(["--target", "--mode", "focused"], {})),
    false,
  );
});

test("invalid destination/mode are rejected", () => {
  assert.equal(
    validateHeadless({
      target: "claude",
      destination: "sideways",
      mode: "focused",
    }),
    false,
  );
  assert.equal(
    validateHeadless({ target: "claude", destination: "split", mode: "bogus" }),
    false,
  );
});

test("--flag=value form works like --flag value", () => {
  assert.deepEqual(
    parseHeadlessArgs(
      ["--target=codex", "--destination=tab", "--mode=full"],
      {},
    ),
    { target: "codex", destination: "tab", mode: "full" },
  );
});

test("env fallbacks fill every flag; CLI wins over env", () => {
  assert.deepEqual(parseHeadlessArgs([], {}), {
    target: null,
    destination: "split",
    mode: "focused",
  });
  assert.deepEqual(
    parseHeadlessArgs([], {
      HERDR_HANDOFF_TARGET: "pi",
      HERDR_HANDOFF_DESTINATION: "tab",
      HERDR_HANDOFF_MODE: "full",
    }),
    { target: "pi", destination: "tab", mode: "full" },
  );
  assert.deepEqual(
    parseHeadlessArgs(["--target", "a"], { HERDR_HANDOFF_TARGET: "b" }),
    { target: "a", destination: "split", mode: "focused" },
  );
});

test("mode env precedence: HERDR_HANDOFF_MODE, HANDOFF_MODE, legacy", () => {
  assert.equal(parseHeadlessArgs([], { HANDOFF_MODE: "full" }).mode, "full");
  assert.equal(
    parseHeadlessArgs([], { HANDOFF_HANDOFF_MODE: "full" }).mode,
    "full",
  );
  assert.equal(
    parseHeadlessArgs([], {
      HERDR_HANDOFF_MODE: "focused",
      HANDOFF_MODE: "full",
    }).mode,
    "focused",
  );
});

// --- source resolution: explicit pane id wins, context JSON is fallback ---

test("HERDR_PANE_ID wins; context JSON focused_pane_id is the fallback", () => {
  assert.equal(resolveHeadlessSource({ HERDR_PANE_ID: "w1:p9" }), "w1:p9");
  assert.equal(
    resolveHeadlessSource({
      HERDR_PANE_ID: "w1:p9",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w5:p1" }),
    }),
    "w1:p9",
  );
  assert.equal(
    resolveHeadlessSource({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w5:p1" }),
    }),
    "w5:p1",
  );
  assert.equal(resolveHeadlessSource({}), null);
  assert.equal(resolveHeadlessSource({ HERDR_PLUGIN_CONTEXT_JSON: "{" }), null);
});

// --- bin exit codes ---

test("bin with no target exits 2 with usage on stderr", () => {
  const res = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /usage: handoff-headless\.js/);
});

test("bin with --target and no Herdr context exits 1 safely", () => {
  const res = spawnSync(process.execPath, [BIN, "--target", "claude"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /not a running agent/);
});

test("bin honours HERDR_HANDOFF_TARGET env", () => {
  const res = spawnSync(process.execPath, [BIN], {
    encoding: "utf8",
    env: { ...process.env, HERDR_HANDOFF_TARGET: "claude" },
  });
  // No Herdr context here, so it must fail as not-an-agent-pane (exit 1),
  // not as missing-target usage (exit 2).
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /not a running agent/);
});

// --- lib: validateTarget + explicitSourcePaneId + HANDOFF_MODE alias ---

function workspace({ agent = "pi" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-headless-"));
  const state = path.join(home, "state");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  const file = path.join(
    home,
    ".pi",
    "agent",
    "sessions",
    "p",
    `2026-07-24T00-00-00-000Z_${ID}.jsonl`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Array.from({ length: 3 }, (_, i) => JSON.stringify({ i })).join("\n") +
      "\n",
  );
  const calls = path.join(home, "calls.jsonl");
  const env = {
    ...process.env,
    PATH: bin,
    PATHEXT: "",
    HOME: home,
    USERPROFILE: home,
    HERDR_BIN_PATH: process.execPath,
    HERDR_PLUGIN_STATE_DIR: state,
    HANDOFF_FAKE_SCRIPT: SCRIPT,
    HANDOFF_FAKE_CALLS: calls,
    HANDOFF_FAKE_AGENT: agent,
    HANDOFF_FAKE_SESSION: JSON.stringify({ kind: "id", value: ID }),
    HANDOFF_SETTLE_MS: "0",
    HANDOFF_STILL_MS: "0",
    HANDOFF_READY_CAP_MS: "0",
    HANDOFF_CONFIRM_WINDOW_MS: "300",
    HANDOFF_PERSIST_MS: "50",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: "w5:p1",
      workspace_id: "w5",
      tab_id: "w5:t1",
      workspace_label: "Herdr",
      tab_label: "1",
      focused_pane_cwd: home,
    }),
    HANDOFF_TEST_HOME: home,
    HANDOFF_FAKE_FOCUSED_SUMMARY: "test summary",
  };
  return { home, env, calls };
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("validateTarget rejects an unknown kind before creating anything", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "split",
    handoffMode: "focused",
    pickerChoice: { selected: "__not_installed__" },
    sourcePaneId: null,
    validateTarget: true,
    env,
  });
  assert.equal(out.ok, false);
  assert.match(out.message, /not installed/);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("pane split")));
  assert.ok(!argv.some((a) => a.startsWith("tab create")));
  assert.ok(!argv.some((a) => a.startsWith("agent start")));
});

test("explicit sourcePaneId is used when context JSON is absent", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "split",
    handoffMode: "focused",
    pickerChoice: { selected: "claude" },
    sourcePaneId: "w5:p1",
    validateTarget: true,
    env: { ...env, HERDR_PLUGIN_CONTEXT_JSON: "{}" },
  });
  // The explicit id is accepted even with no context JSON: the run proceeds
  // all the way to a delivered handoff instead of failing safe.
  assert.equal(out.ok, true, out.message);
  const prompts = readCalls(calls).filter(
    (c) => c[0] === "agent" && c[1] === "prompt",
  );
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][2], "w5:p2");
});

test("HANDOFF_MODE alias selects the mode without opening a picker", async () => {
  const { env } = workspace();
  const out = await run({
    destination: "split",
    dryRun: true,
    env: { ...env, HANDOFF_MODE: "focused" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.handoffMode, "focused");
});

test("legacy HANDOFF_HANDOFF_MODE still selects the mode", async () => {
  const { env } = workspace();
  const out = await run({
    destination: "split",
    dryRun: true,
    env: { ...env, HANDOFF_HANDOFF_MODE: "full" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.handoffMode, "full");
});
