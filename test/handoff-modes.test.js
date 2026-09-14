"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, MESSAGES } = require("../lib/handoff.js");
const { SENTINEL } = require("../lib/briefing.js");

const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";
const SCRIPT = path.join(__dirname, "fixtures", "fake-herdr-session.js");

function workspace({
  agent = "pi",
  sessionRef = { kind: "id", value: ID },
  lines = 3,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-mode-run-"));
  const state = path.join(home, "state");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }

  const body =
    Array.from({ length: lines }, (_, i) => JSON.stringify({ i })).join("\n") +
    "\n";
  const file = path.join(
    home,
    ".pi",
    "agent",
    "sessions",
    "p",
    `2026-07-24T00-00-00-000Z_${ID}.jsonl`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);

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
    HANDOFF_FAKE_SESSION: JSON.stringify(sessionRef),
    HANDOFF_SETTLE_MS: "0",
    HANDOFF_AGY_TUI_SETTLE_MS: "0",
    HANDOFF_STILL_MS: "0",
    HANDOFF_READY_CAP_MS: "0",
    HANDOFF_CONFIRM_WINDOW_MS: "300",
    HANDOFF_PERSIST_MS: "50",
    HANDOFF_FAKE_GET_COUNT: path.join(home, "agent-get-count.txt"),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: "w5:p1",
      workspace_id: "w5",
      tab_id: "w5:t1",
      workspace_label: "Herdr",
      tab_label: "1",
      focused_pane_agent: agent,
      focused_pane_cwd: home,
    }),
    HANDOFF_TEST_HOME: home,
  };
  return { home, env, calls, file };
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const SUMMARY = `# Focused Handoff

## Current objective
- Finish the widget.

## Completed work
- Fixed the parser in lib/widget.js.

## Current state
- Incomplete: one test still fails.

## Remaining work
- Fix the failing test, then stop.

## Important constraints / user preferences
- Keep the change small.

## Pitfalls / do not redo
- Do not re-run the old regex diagnosis; it is solved.

## Relevant files
- lib/widget.js — the fix.
`;

test("cancelling the mode picker stops before the agent picker", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "split",
    env,
    modeChoice: { cancelled: true },
  });
  assert.equal(out.ok, false);
  assert.equal(out.cancelled, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    !argv.some((a) => a.startsWith("plugin pane open")),
    "no picker may open after a mode cancel",
  );
  assert.ok(!argv.some((a) => a.startsWith("tab create")));
  assert.ok(!argv.some((a) => a.startsWith("pane split")));
});

test("the mode picker opens before the agent picker", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "split", env, pickerTimeoutMs: 200 });
  assert.equal(out.cancelled, true, "an unanswered mode picker times out");
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    argv.some((a) => a.includes("--entrypoint mode-picker")),
    `mode picker must open first; got ${JSON.stringify(argv)}`,
  );
  assert.ok(
    !argv.some((a) => a.includes("--entrypoint picker")),
    "the agent picker must not open after a mode cancel",
  );
});

test("full mode preserves the existing full-transcript behavior", async () => {
  const { env, file } = workspace({ lines: 5 });
  const out = await run({
    destination: "split",
    env,
    dryRun: true,
    handoffMode: "full",
  });
  assert.equal(out.ok, true);
  assert.equal(out.handoffMode, "full");
  assert.equal(out.mode, "inline");
  const transcript = fs.readFileSync(file, "utf8");
  assert.ok(out.prompt.includes(transcript));
});

test("focused dry-run builds a focused prompt without opening popups", async () => {
  const { env, calls, file } = workspace({ lines: 5 });
  const out = await run({
    destination: "split",
    env,
    dryRun: true,
    handoffMode: "focused",
    focusedSummary: SUMMARY,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.handoffMode, "focused");
  assert.equal(out.mode, "focused");
  assert.ok(out.prompt.includes("Finish the widget."));
  assert.ok(out.prompt.includes("Handoff mode: focused"));
  assert.ok(out.prompt.trimEnd().endsWith(SENTINEL));
  const transcript = fs.readFileSync(file, "utf8");
  assert.ok(
    !out.prompt.includes(transcript),
    "the transcript body must not travel as the main content",
  );
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("plugin pane open")));
  assert.ok(!argv.some((a) => a.startsWith("pane split")));
});

test("focused mode sends the focused prompt to the target", async () => {
  const { env, calls, file } = workspace();
  const out = await run({
    destination: "split",
    env,
    modeChoice: { mode: "focused" },
    pickerChoice: { selected: "claude" },
    focusedSummary: SUMMARY,
  });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.handoffMode, "focused");
  assert.equal(out.mode, "focused");
  const prompts = readCalls(calls).filter(
    (c) => c[0] === "agent" && c[1] === "prompt",
  );
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][3], out.prompt);
  assert.ok(out.prompt.includes("Finish the widget."));
  const transcript = fs.readFileSync(file, "utf8");
  assert.ok(!out.prompt.includes(transcript));
  assert.match(out.prompt.toLowerCase(), /do not redo completed work/);
  assert.match(out.prompt.toLowerCase(), /do not replay old transcript/);
});

test("focused mode supports the fake-summary env seam", async () => {
  const { env } = workspace();
  const out = await run({
    destination: "split",
    env: { ...env, HANDOFF_FAKE_FOCUSED_SUMMARY: SUMMARY },
    dryRun: true,
    handoffMode: "focused",
  });
  assert.equal(out.ok, true);
  assert.ok(out.prompt.includes("Finish the widget."));
});

test("focused mode supports an injected generator", async () => {
  const { env } = workspace();
  let seen = null;
  const out = await run({
    destination: "split",
    env,
    dryRun: true,
    handoffMode: "focused",
    generateFocusedSummary: async (args) => {
      seen = args;
      return SUMMARY;
    },
  });
  assert.equal(out.ok, true);
  assert.ok(seen && seen.sourcePaneId === "w5:p1");
  assert.ok(out.prompt.includes("Finish the widget."));
});

test("a failing focused summary creates nothing and reports clearly", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "split",
    env,
    modeChoice: { mode: "focused" },
    pickerChoice: { selected: "claude" },
    generateFocusedSummary: async () => {
      throw new Error("source stayed silent");
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.focusedFailed("source stayed silent"));
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("pane split")));
  assert.ok(!argv.some((a) => a.startsWith("tab create")));
  assert.ok(
    !argv.some((c) => c.startsWith("agent prompt w5:p2")),
    "nothing is delivered to a target that was never created",
  );
});

test("an empty focused summary is a failure, not an empty handoff", async () => {
  const { env } = workspace();
  const out = await run({
    destination: "split",
    env,
    dryRun: true,
    handoffMode: "focused",
    focusedSummary: "   ",
    generateFocusedSummary: async () => "   ",
  });
  assert.equal(out.ok, false);
  assert.match(out.message, /Focused handoff unavailable/);
});

test("the default focused path never writes to the source pane", async () => {
  // Regression: the first focused implementation prompted the live source
  // agent for a summary, so the handoff appeared to run in the same agent
  // while no new pane was created. The default path must not send the source
  // anything — no seams, no generator, just the transcript on disk.
  const { env, calls, file } = workspace();
  const out = await run({
    destination: "split",
    env,
    modeChoice: { mode: "focused" },
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.handoffMode, "focused");
  assert.equal(out.mode, "focused");

  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    argv.some((a) => a.startsWith("pane split")),
    "the target pane is created",
  );
  const prompts = readCalls(calls).filter(
    (c) => c[0] === "agent" && c[1] === "prompt",
  );
  assert.equal(prompts.length, 1, "exactly one prompt is sent anywhere");
  assert.equal(
    prompts[0][2],
    "w5:p2",
    "the one prompt goes to the new target pane, never the source",
  );
  assert.equal(prompts[0][3], out.prompt);
  const transcript = fs.readFileSync(file, "utf8");
  assert.ok(
    !out.prompt.includes(transcript),
    "the transcript body must not travel as the main content",
  );
});

test("a target that resolves to the source pane is never typed into", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "split",
    env: { ...env, HANDOFF_FAKE_SPLIT_PANE: "w5:p1" },
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.targetCreateFailed("split"));
  const prompts = readCalls(calls).filter(
    (c) => c[0] === "agent" && c[1] === "prompt",
  );
  assert.equal(
    prompts.length,
    0,
    "nothing may be delivered when the target is the source pane",
  );
});
