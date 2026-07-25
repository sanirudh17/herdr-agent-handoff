const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, MESSAGES, shellIsAtPrompt, startingUp, needsAnswer } = require("../lib/handoff.js");

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
    // Real delivery backoff spans about a minute; the tests should not.
    HANDOFF_SETTLE_MS: "0",
    HANDOFF_STILL_MS: "0",
    HANDOFF_READY_CAP_MS: "0",
    HANDOFF_CONFIRM_WINDOW_MS: "300",
    // By default the fake agent reacts to a prompt, as a healthy one would.
    HANDOFF_FAKE_GET_COUNT: path.join(home, "agent-get-count.txt"),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: "w5:p1", workspace_id: "w5", tab_id: "w5:t1",
      workspace_label: "Herdr", tab_label: "1",
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
  env.HANDOFF_AGENT_START = "native"; // pin the launch strategy; order is what matters here
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
    assert.ok(
      !(text.startsWith("pane run") && text.includes("w5:p1")),
      "must never run a command in the source pane"
    );
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
  env.HANDOFF_AGENT_START = "native";
  env.HANDOFF_FAKE_FAIL = "agent start";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.startFailed("Claude Code"));
  assert.ok(!readCalls(calls).some((c) => c[0] === "agent" && c[1] === "prompt"));
});

test("a failed pane-shell launch reports and does not prompt", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_AGENT_START = "pane-run";
  env.HANDOFF_FAKE_FAIL = "pane run";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.startFailed("Claude Code"));
  assert.ok(!readCalls(calls).some((c) => c[0] === "agent" && c[1] === "prompt"));
});

test("a failed prompt reports the prompt failure", async () => {
  const { env } = workspace();
  env.HANDOFF_FAKE_FAIL = "agent prompt";
  // Neither proof of delivery: nothing on screen, and the agent never stirs.
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_NO_SEQ = "1";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.promptFailed("Claude Code"));
});

test("delivery is proven by the prompt appearing in the target, not by the submit call", async () => {
  const { env, calls } = workspace();
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    argv.some((a) => a.startsWith("agent read w5:p2")),
    "the target's own screen is the proof of delivery"
  );
});

test("a confirmed prompt is submitted only once", async () => {
  const { env, calls } = workspace();
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  const prompts = readCalls(calls).filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 1, "confirmation stops the loop immediately");
});

test("the handoff is never sent more than once", async () => {
  // Antigravity buffers sends made while it finishes signing in and flushes them
  // together: six retries put five copies of the same handoff into it. Whatever
  // the outcome, it goes out once.
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, false, "unconfirmed delivery is never reported as success");
  const prompts = readCalls(calls).filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 1, "one submission, so the task cannot be handed over twice");
});

test("readiness is judged from the target's screen, not its reported state", async () => {
  const { env, calls } = workspace();
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  const argv = readCalls(calls).map((c) => c.join(" "));
  const reads = argv.filter((a) => a.startsWith("agent read w5:p2"));
  assert.ok(reads.length > 0, "the target's screen is what gates the submission");
});

test("a state change alone is never treated as delivery", async () => {
  // agy churns through states while signing in. Live, that was mistaken for a
  // delivered handoff while it sat at an empty prompt.
  const { env, home } = workspace();
  env.HANDOFF_FAKE_REACTS = "never"; // nothing on screen
  env.HANDOFF_FAKE_GET_COUNT = path.join(home, "seq.txt"); // but the state moves
  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, false, "churn is not proof the prompt arrived");
  assert.equal(out.message, MESSAGES.promptFailed("Antigravity CLI"));
});

test("closing the target mid-confirmation is not reported as a failure", async () => {
  const { env } = workspace();
  // The user read the result and closed the pane. The handoff worked; saying it
  // failed would be a lie.
  env.HANDOFF_FAKE_FAIL = "agent read";
  env.HANDOFF_FAKE_ERROR_CODE = "agent_not_found";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true);
  assert.equal(out.closed, true);
  assert.equal(out.message, "", "no toast for a pane the user deliberately closed");
});

test("the source pane's screen is never read, only the target's", async () => {
  const { env, calls } = workspace();
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  for (const call of readCalls(calls)) {
    const text = call.join(" ");
    assert.ok(!text.startsWith("pane read"), "pane scrollback is never a source of context");
    if (text.startsWith("agent read")) {
      assert.ok(
        !text.includes("w5:p1"),
        `the source pane's screen must never be read: ${text}`
      );
    }
  }
});

test("only installed agents are offered to the picker", async () => {
  const { env } = workspace();
  const out = await run({ destination: "tab", env, dryRun: true });
  assert.deepEqual(out.request.installed.map((a) => a.kind).sort(), ["claude", "codex", "pi"]);
  assert.equal(out.request.notInstalled.length, 18);
  assert.equal(out.request.installed.find((a) => a.kind === "pi").isSource, true);
});

test("the picker request describes places by label, never by raw id", async () => {
  const { env } = workspace();
  const split = await run({ destination: "split", env, dryRun: true });
  assert.match(split.request.contextLine, /^pi in Herdr · tab 1/);
  assert.equal(split.request.destination, "split beside it");

  const tab = await run({ destination: "tab", env, dryRun: true });
  assert.equal(tab.request.destination, "new tab in Herdr");

  for (const text of [split.request.contextLine, split.request.destination, tab.request.destination]) {
    assert.ok(!/w\d+:[pt]\d+/.test(text), `raw id leaked into "${text}"`);
  }
});

test("the picker request carries the not-installed roster so it can be browsed", async () => {
  const { env } = workspace();
  const out = await run({ destination: "tab", env, dryRun: true });
  assert.ok(out.request.notInstalled.every((a) => a.kind && a.name));
  assert.ok(out.request.notInstalled.some((a) => a.kind === "gemini"));
});

test("a screen showing sign-in text means the target is not ready", () => {
  // Antigravity's own wording, plus the phrasings other agents use.
  assert.equal(startingUp("  Signing in...  ? for shortcuts"), true);
  assert.equal(startingUp("Authenticating with the API"), true);
  assert.equal(startingUp("Please wait, initializing"), true);
  assert.equal(startingUp("LOGGING IN"), true, "matching is case-insensitive");
});

test("an ordinary agent prompt counts as ready", () => {
  // Crucially, a spinner or a token counter must NOT read as "starting up": that
  // is what kept every handoff waiting out the whole cap for ninety seconds.
  assert.equal(startingUp("> \n? for shortcuts   Gemini 3.6 Flash · low"), false);
  assert.equal(startingUp("⠹ Working... 3%/272k · $0.04"), false);
  assert.equal(startingUp(""), false);
  assert.equal(startingUp(null), false);
});

test("a question on screen is recognised as needing the user, not as slowness", () => {
  // Antigravity's first run in a directory opens a folder-trust gate.
  assert.equal(needsAnswer("Do you trust the files in this folder?"), true);
  assert.equal(needsAnswer("  requesting permission for: write  "), true);
  assert.equal(needsAnswer("Continue? [y/N]"), true);
  assert.equal(needsAnswer("1. Yes, proceed  2. No"), true);
});

test("an ordinary prompt is not mistaken for a question", () => {
  assert.equal(needsAnswer("> \n? for shortcuts"), false);
  assert.equal(needsAnswer("⠹ Working..."), false);
  assert.equal(needsAnswer(null), false);
});

test("a target waiting on the user is never typed into", async () => {
  const { env, calls } = workspace();
  // A trust gate on screen, and Herdr reporting it blocked.
  env.HANDOFF_FAKE_SCREEN = "Do you trust the files in this folder? 1. Yes 2. No";
  env.HANDOFF_FAKE_STATUS = "blocked";
  env.HANDOFF_READY_CAP_MS = "600";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, false);
  assert.equal(out.needsAttention, true);
  assert.equal(out.message, MESSAGES.needsAttention("Antigravity CLI"));

  const prompts = readCalls(calls).filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 0, "typing into a trust dialog could answer it — never do it");
});

test("the message for a waiting target says nothing was typed", () => {
  const m = MESSAGES.needsAttention("Antigravity CLI");
  assert.match(m, /asking you something/i);
  assert.match(m, /nothing was typed/i);
});

test("a slow-starting target is announced instead of leaving a silent pane", () => {
  assert.match(MESSAGES.startingUp("Antigravity CLI"), /still starting up/i);
  assert.match(MESSAGES.startingUp("Antigravity CLI"), /Antigravity CLI/);
});

test("a shell listing only itself in the foreground is at its prompt", () => {
  // Windows reports the shell as its own foreground process; an empty list is
  // the POSIX shape. Both mean ready.
  assert.equal(
    shellIsAtPrompt({ shell_pid: 100, foreground_processes: [{ pid: 100, name: "powershell.exe" }] }),
    true
  );
  assert.equal(shellIsAtPrompt({ shell_pid: 100, foreground_processes: [] }), true);
  assert.equal(shellIsAtPrompt({ shell_pid: 100 }), true);
});

test("a shell running something else is not at its prompt", () => {
  assert.equal(
    shellIsAtPrompt({ shell_pid: 100, foreground_processes: [{ pid: 777, name: "node.exe" }] }),
    false
  );
  assert.equal(shellIsAtPrompt({}), false);
  assert.equal(shellIsAtPrompt(null), false);
});

test("agent start is used where it works", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_AGENT_START = "native";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(argv.some((a) => a.startsWith("agent start")), "should use the documented path");
  assert.ok(!argv.some((a) => a.startsWith("pane run")), "no need for the workaround");
});

test("the Windows workaround launches the agent through the pane shell", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_AGENT_START = "pane-run";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    !argv.some((a) => a.startsWith("agent start")),
    "agent start renders an empty -ArgumentList on Windows and must be avoided"
  );
  assert.ok(argv.some((a) => a === "pane run w5:p2 claude"), `got ${JSON.stringify(argv)}`);
  assert.ok(argv.some((a) => a.startsWith("agent wait w5:p2")), "must wait for readiness");
  assert.ok(argv.some((a) => a.startsWith("agent prompt w5:p2")), "prompt addresses the pane");
});

test("the workaround uses the executable name that actually resolved", async () => {
  const { env, home, calls } = workspace();
  env.HANDOFF_AGENT_START = "pane-run";
  // cursor resolves as cursor-agent, not cursor.
  fs.writeFileSync(path.join(home, "bin", "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const out = await run({ destination: "split", env, pickerChoice: { selected: "cursor" } });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(argv.some((a) => a === "pane run w5:p2 cursor-agent"), `got ${JSON.stringify(argv)}`);
});
