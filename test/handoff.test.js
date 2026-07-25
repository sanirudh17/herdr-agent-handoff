const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, MESSAGES } = require("../lib/handoff.js");

const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";
const SCRIPT = path.join(__dirname, "fixtures", "fake-herdr-session.js");

function workspace({ agent = "pi", sessionRef = { kind: "id", value: ID }, lines = 3 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-run-"));
  const state = path.join(home, "state");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }

  const body = Array.from({ length: lines }, (_, i) => JSON.stringify({ i })).join("\n") + "\n";
  const file = path.join(home, ".pi", "agent", "sessions", "p", `2026-07-24T00-00-00-000Z_${ID}.jsonl`);
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
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: "w5:p1", workspace_id: "w5", tab_id: "w5:t1",
      focused_pane_agent: agent, focused_pane_cwd: home,
    }),
    HANDOFF_TEST_HOME: home,
  };
  return { home, env, calls, file };
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("dry run resolves and snapshots without creating panes", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "tab", env, dryRun: true });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(argv.some((a) => a.startsWith("pane get")), "should read the source pane");
  assert.ok(!argv.some((a) => a.startsWith("pane split")), "must not split in dry run");
  assert.ok(!argv.some((a) => a.startsWith("tab create")), "must not create a tab in dry run");
  assert.ok(!argv.some((a) => a.startsWith("agent start")), "must not start an agent in dry run");
});

test("dry run writes a complete snapshot and briefing", async () => {
  const { env } = workspace({ lines: 5 });
  const out = await run({ destination: "split", env, dryRun: true });
  const dir = out.handoffDir;
  assert.ok(fs.existsSync(path.join(dir, "HANDOFF.md")));
  assert.ok(fs.existsSync(path.join(dir, "SOURCE.json")));
  const source = JSON.parse(fs.readFileSync(path.join(dir, "SOURCE.json"), "utf8"));
  assert.equal(source.total_lines, 5);
  const parts = fs.readdirSync(path.join(dir, "session"));
  const joined = Buffer.concat(parts.sort().map((p) => fs.readFileSync(path.join(dir, "session", p))));
  assert.equal(joined.toString(), fs.readFileSync(source.native_path, "utf8"));
});

test("a pane with no agent fails before opening the picker", async () => {
  const { env, calls } = workspace({ agent: "" });
  const out = await run({ destination: "tab", env });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.notAgentPane);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("plugin pane open")), "picker must not open");
});

test("an unresolvable source fails before opening the picker", async () => {
  const { env, calls } = workspace({ agent: "claude" });
  const out = await run({ destination: "tab", env });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.noContext);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("plugin pane open")), "picker must not open");
});

test("a non-integrated source kind fails with the context message", async () => {
  const { env } = workspace({ agent: "agy", sessionRef: null });
  const out = await run({ destination: "tab", env });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.noContext);
});

test("cancelling the picker leaves nothing created and reports nothing", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "tab", env, pickerChoice: { cancelled: true } });
  assert.equal(out.ok, false);
  assert.equal(out.cancelled, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("tab create")));
  assert.ok(!argv.some((a) => a.startsWith("notification show")));
});

test("split handoff splits beside the source, starts, prompts, focuses and notifies", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true);
  assert.equal(out.message, "Handoff started: pi → Claude Code (split)");
  const argv = readCalls(calls).map((c) => c.join(" "));
  const order = ["pane split", "agent start", "agent prompt", "agent focus", "notification show"];
  let cursor = -1;
  for (const step of order) {
    const at = argv.findIndex((a, i) => i > cursor && a.startsWith(step));
    assert.ok(at > cursor, `${step} must run after the previous step; got ${JSON.stringify(argv)}`);
    cursor = at;
  }
  assert.ok(argv.some((a) => a.startsWith("pane split") && a.includes("--pane w5:p1")));
  assert.ok(argv.some((a) => a.startsWith("pane split") && a.includes("--direction right")));
  assert.ok(argv.some((a) => a.startsWith("pane split") && a.includes("--no-focus")));
});

test("tab handoff creates a tab in the source workspace and resolves its pane", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "tab", env, pickerChoice: { selected: "codex" } });
  assert.equal(out.ok, true);
  assert.equal(out.message, "Handoff started: pi → Codex (new tab)");
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(argv.some((a) => a.startsWith("tab create") && a.includes("--workspace w5")));
  assert.ok(argv.some((a) => a.startsWith("pane list")), "must resolve the new tab's pane");
});

test("the source pane is only ever read", async () => {
  const { env, calls } = workspace();
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  for (const call of readCalls(calls)) {
    const text = call.join(" ");
    const touchesSource = text.includes("w5:p1");
    const isRead =
      text.startsWith("pane get") || text.startsWith("pane split") || text.startsWith("pane list");
    assert.ok(!touchesSource || isRead, `unexpected write to the source pane: ${text}`);
    assert.ok(!text.startsWith("pane send-text"), "must never send text to a pane");
    assert.ok(!text.startsWith("pane send-keys"), "must never send keys to a pane");
    assert.ok(!text.startsWith("pane close"), "must never close a pane");
    assert.ok(!text.startsWith("pane read"), "must never read scrollback");
  }
});

test("the prompt is a single line pointing at HANDOFF.md", async () => {
  const { env, calls } = workspace();
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  const prompt = readCalls(calls).find((c) => c[0] === "agent" && c[1] === "prompt");
  assert.ok(prompt, "expected an agent prompt call");
  const text = prompt[3];
  assert.ok(!text.includes("\n"), "prompt must be one line");
  assert.match(text, /HANDOFF\.md/);
  assert.match(text, /^Session handoff from pi\./);
});

test("a failed target creation reports and creates no agent", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_FAIL = "pane split";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.targetCreateFailed("split"));
  assert.ok(!readCalls(calls).some((c) => c[0] === "agent" && c[1] === "start"));
});

test("a failed agent start reports and does not prompt", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_FAIL = "agent start";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.startFailed("Claude Code"));
  assert.ok(!readCalls(calls).some((c) => c[0] === "agent" && c[1] === "prompt"));
});

test("a failed prompt reports the prompt failure", async () => {
  const { env } = workspace();
  env.HANDOFF_FAKE_FAIL = "agent prompt";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.promptFailed("Claude Code"));
});

test("only installed agents are offered to the picker", async () => {
  const { env } = workspace();
  const out = await run({ destination: "tab", env, dryRun: true });
  assert.deepEqual(out.request.available.map((a) => a.kind).sort(), ["claude", "codex", "pi"]);
  assert.equal(out.request.unavailableCount, 18);
  assert.equal(out.request.available.find((a) => a.kind === "pi").isSource, true);
});
