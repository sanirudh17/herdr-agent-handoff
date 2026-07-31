const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  run, MESSAGES, shellIsAtPrompt, startingUp, needsAnswer, usable,
  readScreenForTest, flat, inputLineIndex, timings,
} = require("../lib/handoff.js");
const herdr = require("../lib/herdr.js");
const briefing = require("../lib/briefing.js");

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
    HANDOFF_AGY_SETTLE_MS: "0",
    HANDOFF_STILL_MS: "0",
    HANDOFF_READY_CAP_MS: "0",
    HANDOFF_CONFIRM_WINDOW_MS: "300",
    HANDOFF_PERSIST_MS: "50",
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

// A workspace whose source agent is opencode: a real SQLite store, because that
// is the one source with no per-session file to point a target at.
const OC_SID = "ses_06af8a6fcffeIyWB7w5lX0xE7y";
function opencodeWorkspace({ rows = 3, pad = 200 } = {}) {
  const { env, home } = workspace({ agent: "opencode", sessionRef: { kind: "id", value: OC_SID } });
  const dir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
      agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?)")
    .run(OC_SID, "proj", "/w", "Fix the parser", "build", "opus", 1, 2);
  const insert = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
  for (let i = 0; i < rows; i += 1) {
    insert.run(`m${i}`, OC_SID, i, i, JSON.stringify({ role: "user", text: "x".repeat(pad) }));
  }
  db.close();

  return { env, home, dbPath, sessionId: OC_SID };
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

test("a dry run builds the whole handoff into the prompt and writes nothing", async () => {
  const { env, home, file } = workspace({ lines: 5 });
  const out = await run({ destination: "split", env, dryRun: true });

  assert.equal(out.mode, "inline", "five lines fit inside the prompt");
  assert.match(out.prompt, /^You are taking over this session from/);
  assert.equal(out.handoffDir, undefined, "there is no handoff directory any more");

  const transcript = fs.readFileSync(file, "utf8");
  assert.ok(out.prompt.includes(transcript), "the session travels verbatim inside the prompt");
  assert.ok(!fs.existsSync(path.join(home, "state", "handoffs")), "no handoffs directory");
});

test("a session too large to inline becomes a reference to the agent's own file", async () => {
  const { env, home, file } = workspace({ lines: 4000 });
  const out = await run({ destination: "split", env, dryRun: true });

  assert.equal(out.mode, "reference");
  assert.ok(out.prompt.includes(file), "the prompt names the source agent's own transcript");
  assert.ok(out.prompt.length < 32_767, "and still fits the command line");
  assert.ok(!fs.existsSync(path.join(home, "state", "handoffs")), "still nothing written");
});

test("an over-budget source that is not readable text reports no full context", async () => {
  const { env, file } = workspace({ lines: 4000 });
  // A layout that resolves to bytes no target can read as lines. Over budget, that
  // cannot be handed over honestly, so it must not be handed over at all.
  const body = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x00]), body]));

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.noContext);
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
  const order = ["pane split", "pane run", "agent prompt", "agent focus", "notification show"];
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
    // Check the pane the command *addresses*, not the text it carries. The prompt
    // body names the source pane in its identity table and its boundary rule, and a
    // substring scan cannot tell that from writing to it.
    const addressed = call[0] === "agent" && call[1] === "prompt" ? call.slice(0, 3) : call;
    const touchesSource = addressed.some((arg) => arg === "w5:p1");
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

test("the prompt the target receives is exactly the prompt that was built", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  const prompts = readCalls(calls).filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 1, "submitted exactly once");
  assert.equal(prompts[0][3], out.prompt, "nothing is added or trimmed on the way out");
  assert.match(out.prompt, /^You are taking over this session from \*\*pi\*\*/);
  assert.ok(!out.prompt.includes("HANDOFF.md"), "there is no document to point at");
});

test("a failed target creation reports and creates no agent", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_FAIL = "pane split";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.targetCreateFailed("split"));
  assert.ok(!readCalls(calls).some((c) => c[0] === "agent" && c[1] === "start"));
});

test("a failed native agent start reports and does not prompt", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_AGENT_START = "native";
  env.HANDOFF_FAKE_FAIL = "agent start";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "pi" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.startFailed("pi"));
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

test("a redraw alone is never accepted as delivery", async () => {
  // Measured on Antigravity: it prints "Verifying your account…" several seconds
  // after its screen has gone quiet, and that late redraw is indistinguishable
  // from a reply. Accepting it announced a handoff that had not been delivered —
  // the worst outcome available here.
  const { env } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";  // never echoes the prompt
  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, false, "a screen that merely changed proves nothing");
  assert.equal(out.message, MESSAGES.promptFailed("Antigravity CLI"));
});

test("a state change alone is never accepted as delivery", async () => {
  const { env, home } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_GET_COUNT = path.join(home, "seq.txt"); // state moves on its own
  const out = await run({ destination: "split", env, pickerChoice: { selected: "opencode" } });
  assert.equal(out.ok, false, "a settling agent changes state by itself");
});

test("a prompt echoed and then discarded is not a delivery", async () => {
  // Antigravity echoes the text into its input box and drops it if its account
  // check is still running. The marker showed 117ms after submission and was gone
  // six seconds later, replaced by "Verifying your account…".
  const { env } = workspace();
  env.HANDOFF_FAKE_ECHO_THEN_DROP = "1";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, false, "an echo that does not survive is not acceptance");
  // Reported as not-yet-ready rather than as a question: the account check is why
  // it dropped the prompt, and nothing was asked of the user.
  assert.equal(out.notReady, true);
  assert.equal(out.message, MESSAGES.notReady("Antigravity CLI"));
});

test("delivery is confirmed only by the prompt appearing", async () => {
  const { env } = workspace();
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true, "the fake echoes the prompt, which is the one accepted proof");
});

test("the handoff is never sent more than once", async () => {
  // Antigravity buffers sends made while it finishes signing in and flushes them
  // together: six retries put five copies of the same handoff into it. Whatever
  // the outcome, it goes out once.
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_FROZEN = "1";
  env.HANDOFF_FAKE_NO_SEQ = "1";
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

test("a busy target is waited for, then still handed off", async () => {
  // Two different situations, deliberately treated differently. A target mid-turn
  // is only busy: the handoff queues behind that turn, so it is waited for and
  // then sent. A target asking a question is another matter — see the trust-gate
  // test — because the Enter after our text could answer it.
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_STATUS = "working";
  env.HANDOFF_READY_CAP_MS = "600";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, true);
  const prompts = readCalls(calls).filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 1, "busy is a reason to wait, not to give up");
});

// The screen has to arrive the way the CLI sends it. readScreen used to return
// normalize(out), which collapses every run of whitespace to one space: measured on
// live panes, raw captures carried 52 (pi) and 37 (agy) newlines and the normalised
// strings carried zero. Any rule that reasons about line structure was dead on
// arrival, which is how an unreachable rule came to look tested.
function screenFrom(file) {
  const env = {
    ...process.env,
    HERDR_BIN_PATH: process.execPath,
    HANDOFF_FAKE_SCRIPT: SCRIPT,
    FAKE_SCREEN_FILE: file,
  };
  const call = (args, opts = {}) => herdr.run([SCRIPT, ...args], { env, ...opts });
  return readScreenForTest(call, "w1:p1");
}

test("readScreen hands back the screen with its lines intact", () => {
  const screen = "banner line\n\n  ─────❯      ─────\n? for shortcuts\n";
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "screen-")), "s.txt");
  fs.writeFileSync(file, screen);

  const got = screenFrom(file);
  assert.equal(got, screen, "not one newline may be lost on the way in");
  assert.ok(got.includes("\n"), "this is the guard: no newline means the line rules cannot fire");
});

test("flat collapses whitespace for phrase matching without destroying the source", () => {
  assert.equal(flat("a\n\n  b"), "a b");
  assert.equal(flat(null), "");
});

// These four are real captures taken from live panes, held as files and served
// through the fake CLI. A literal in this file could carry a shape the CLI never
// produces - Grok's capture has no newline in it at all - and that is exactly how
// the previous rule came to look tested while being unreachable.
const SCREENS = path.join(__dirname, "fixtures", "screens");
const screen = (name) => screenFrom(path.join(SCREENS, name));

test("every screen fixture arrives with the bytes its file holds", () => {
  for (const name of ["agy-verifying.txt", "claude-idle.txt", "grok-idle.txt", "codex-trust.txt"]) {
    assert.equal(screen(name), fs.readFileSync(path.join(SCREENS, name), "utf8"),
      `${name} was altered on the way in`);
  }
});

test("Antigravity's account banner above its input line is history, not current state", () => {
  assert.equal(startingUp(screen("agy-verifying.txt")), false,
    "the notice sits above a drawn input box; the agent is waiting for input");
});

test("the same notice with no input box anywhere is current state", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nobox-")), "s.txt");
  fs.writeFileSync(file,
    "⚠️Verifying your account...\n └ We're finishing verifying your account eligibility.\n");
  assert.equal(startingUp(screenFrom(file)), true);
});

test("Claude Code's prompt drawn inside a border line is found", () => {
  const lines = screen("claude-idle.txt").split("\n");
  const i = inputLineIndex(lines);
  assert.ok(i >= 0, "───────❯──────── is an input line");
  assert.ok(lines[i].includes("❯"));
});

test("Grok's box-drawn prompt is found when the capture has lines", () => {
  assert.equal(inputLineIndex(["╭─────────╮", "│ >       │", "╰─ Grok ──╯"]), 1);
});

test("a capture with no newlines falls back to the character tail rather than guessing", () => {
  const raw = screen("grok-idle.txt");
  assert.ok(!raw.includes("\n"), "this is what the CLI actually returns for Grok");
  assert.equal(inputLineIndex(raw.split("\n")), -1, "one line: nothing to reason about");
  assert.equal(startingUp(raw), false, "and its tail holds no startup phrase");
});

test("a startup notice below the input line still counts", () => {
  const lines = ["> ", "────────────", "Signing in to your account…"];
  assert.equal(startingUp(lines.join("\n")), true,
    "a footer notice is current state, unlike a banner above the box");
});

test("Codex's trust dialog is a question, and questions are never typed into", () => {
  assert.equal(needsAnswer(screen("codex-trust.txt")), true);
});

test("prose containing a quoted line is not mistaken for an input box", () => {
  const lines = [
    "> the previous agent wrote this in a markdown blockquote",
    "and then twelve more lines of ordinary output followed",
    "line 3", "line 4", "line 5", "line 6", "line 7", "line 8", "line 9", "line 10",
    "Signing in to your account…",
  ];
  assert.equal(startingUp(lines.join("\n")), true,
    "the quote is far above the bottom and must not shield the notice");
});

test("closing the target mid-confirmation is not reported as a failure", async () => {
  const { env } = workspace();
  // The user read the result and closed the pane. The handoff worked; saying it
  // failed would be a lie. The pane goes with the agent, which is what tells this
  // apart from an agent that crashed and left its pane behind.
  env.HANDOFF_FAKE_FAIL = "agent read";
  env.HANDOFF_FAKE_ERROR_CODE = "agent_not_found";
  env.HANDOFF_FAKE_PANE_GONE = "w5:p2";
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

test("a blank pane is not a ready agent", () => {
  // opencode reads 0 characters for its first five seconds while Herdr reports
  // "idle" throughout. Treating that as a calm, settled agent is what submitted
  // the handoff into a pane whose TUI had not painted yet.
  assert.equal(usable(""), false);
  assert.equal(usable(null), false);
  assert.equal(usable("> ? for shortcuts"), true);
});

test("a usage-credit footer is not treated as an agent that cannot run", () => {
  // Antigravity shows "AI: Out of credits" in its footer while still working
  // perfectly — it falls back to another allowance. Reading capability off a
  // status line blocked handoffs to a healthy agent.
  const footer = "Gemini 3.6 Flash · low · AI: Out of credits";
  assert.equal(startingUp(footer), false, "a credit footer is not a startup state");
  assert.equal(needsAnswer(footer), false, "and it is not a question either");
});

test("a startup notice scrolled into the past no longer means not ready", () => {
  // Antigravity leaves "Verifying your account…" in its transcript long after it
  // stops being true. Matching the whole capture left the target permanently
  // "starting up", and one handoff waited out the full 180s cap before sending.
  const scrolled =
    "Verifying your account... please try again shortly. " +
    "x".repeat(600) +
    " > ? for shortcuts   Gemini 3.6 Flash · low";
  assert.equal(startingUp(scrolled), false, "only the current view decides readiness");

  const current = "x".repeat(600) + " Verifying your account... please try again shortly.";
  assert.equal(startingUp(current), true, "still showing it means still starting");
});

test("account verification counts as not ready", () => {
  // Antigravity's first-run wording, which is neither a sign-in nor a question.
  assert.equal(startingUp("⚠ Verifying your account... Please try again shortly."), true);
});

test("a target showing a credit footer is still handed off to", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_SCREEN = "Gemini 3.6 Flash low AI: Out of credits";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, true, "the footer says nothing about whether it can take work");
  const prompts = readCalls(calls).filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 1);
});

test("a question on screen is recognised as needing the user, not as slowness", () => {
  // Antigravity's first run in a directory opens a folder-trust gate.
  assert.equal(needsAnswer("Do you trust the files in this folder?"), true);
  assert.equal(needsAnswer("  requesting permission for: write  "), true);
  assert.equal(needsAnswer("Continue? [y/N]"), true);
  assert.equal(needsAnswer("1. Yes, proceed  2. No"), true);
});

test("a login menu is a question, not a ready agent", () => {
  // Measured: a fresh Antigravity pane offers "Select login method: > 1. Google
  // OAuth". A prompt typed into that is taken as a menu choice — it started an
  // OAuth flow that ended in "token exchange failed".
  const menu = "Select login method: > 1. Google OAuth 2. Use a Google Cloud project " +
    "[Use arrow keys to navigate, Enter to select]";
  assert.equal(needsAnswer(menu), true);
  assert.equal(needsAnswer("Press any key to go back."), true);
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

test("Antigravity waits 10 seconds before the handoff prompt", () => {
  assert.equal(timings({}).agySettle, 10000);
  assert.equal(timings({ HANDOFF_AGY_SETTLE_MS: "8000" }).agySettle, 8000);
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

test("agent start is used where no launch arguments are needed", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_AGENT_START = "native";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "pi" } });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(argv.some((a) => a.startsWith("agent start")), "should use the documented path");
  assert.ok(!argv.some((a) => a.startsWith("pane run")), "no need for the workaround");
});

test("the pane-shell launch includes Claude's bypass-permissions argument", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_AGENT_START = "pane-run";
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    !argv.some((a) => a.startsWith("agent start")),
    "agent start renders an empty -ArgumentList on Windows and must be avoided"
  );
  assert.ok(
    argv.some((a) => a === "pane run w5:p2 claude --dangerously-skip-permissions"),
    `got ${JSON.stringify(argv)}`
  );
  assert.ok(argv.some((a) => a.startsWith("agent wait w5:p2")), "must wait for readiness");
  assert.ok(argv.some((a) => a.startsWith("agent prompt w5:p2")), "prompt addresses the pane");
});

test("Antigravity starts without TERM in a Windows Herdr pane", async () => {
  const { env, home, calls } = workspace();
  env.HANDOFF_AGENT_START = "pane-run";
  fs.writeFileSync(path.join(home, "bin", "agy"), "#!/bin/sh\n", { mode: 0o755 });

  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, true);

  const argv = readCalls(calls).map((c) => c.join(" "));
  const command = "pane run w5:p2 $env:TERM=''; agy --dangerously-skip-permissions";
  if (process.platform === "win32") {
    assert.ok(argv.some((a) => a === command), `got ${JSON.stringify(argv)}`);
  } else {
    assert.ok(argv.some((a) => a === "pane run w5:p2 agy --dangerously-skip-permissions"), `got ${JSON.stringify(argv)}`);
  }
});

test("the workaround uses the executable name that actually resolved", async () => {
  const { env, home, calls } = workspace();
  env.HANDOFF_AGENT_START = "pane-run";
  // cursor resolves as cursor-agent, not cursor.
  fs.writeFileSync(path.join(home, "bin", "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const out = await run({ destination: "split", env, pickerChoice: { selected: "cursor" } });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(argv.some((a) => a === "pane run w5:p2 cursor-agent --yolo"), `got ${JSON.stringify(argv)}`);
});

// opencode's only store is a single database with no per-session files, verified
// at 304 MiB on the machine this was built on. A session too large to inline has
// to be materialised somewhere; this is the one place the plugin writes anything.
const OC_SKIP = !require("../lib/source-sqlite.js").hasSqlite()
  ? "node:sqlite unavailable (needs Node 22.5+)"
  : false;

test("a large opencode session is exported once, beside its own database", { skip: OC_SKIP }, async () => {
  const { env, dbPath, sessionId } = opencodeWorkspace({ rows: 200 });
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });

  assert.equal(out.ok, true);
  assert.equal(out.mode, "reference");

  const exported = path.join(path.dirname(dbPath), `herdr-handoff-${sessionId}.jsonl`);
  assert.ok(fs.existsSync(exported), "the one documented exception");
  assert.ok(out.prompt.includes(exported), "and the prompt points at it");
  assert.ok(!out.prompt.includes("opencode.db"), "never at the database itself");
});

test("handing off the same opencode session twice leaves one file, not two", { skip: OC_SKIP }, async () => {
  const { env, dbPath, sessionId } = opencodeWorkspace({ rows: 200 });
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  await run({ destination: "split", env, pickerChoice: { selected: "claude" } });

  const ours = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.startsWith("herdr-handoff-"));
  assert.deepEqual(ours, [`herdr-handoff-${sessionId}.jsonl`], "overwritten, never accumulated");
});

test("a small opencode session is inlined and writes nothing at all", { skip: OC_SKIP }, async () => {
  const { env, dbPath } = opencodeWorkspace({ rows: 3, pad: 20 });
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });

  assert.equal(out.mode, "inline");
  const ours = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.startsWith("herdr-handoff-"));
  assert.deepEqual(ours, [], "under budget, opencode gets no exception either");
});

test("a prompt left unsent in the composer is submitted with one Enter", async () => {
  // Measured: Claude Code parks a pasted prompt at "[Pasted text #1 +74 lines]" and
  // Codex at "[Pasted Content 6999 chars]", both idle and still unsent twenty
  // seconds later. Without this the handoff lands and is reported as a failure.
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_NEEDS_ENTER = "1";
  env.HANDOFF_NUDGE_MS = "50";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true, out.message);

  const argv = readCalls(calls);
  const enters = argv.filter((c) => c[0] === "agent" && c[1] === "send-keys" && c[3] === "enter");
  assert.equal(enters.length, 1, "exactly one Enter, never a stream of them");
  assert.equal(enters[0][2], "w5:p2", "sent to the target, never the source");

  const prompts = argv.filter((c) => c[0] === "agent" && c[1] === "prompt");
  assert.equal(prompts.length, 1, "the prompt itself is still submitted only once");
});

test("an agent that submits a pasted prompt itself is never sent an Enter", async () => {
  // pi does submit on its own. Spending the Enter there would put a stray empty
  // message into a healthy handoff.
  const { env, calls } = workspace();
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true, out.message);
  assert.ok(
    !readCalls(calls).some((c) => c[0] === "agent" && c[1] === "send-keys"),
    "no keys are sent when the marker showed up on its own"
  );
});

test("the Enter is never spent on a target showing a question", async () => {
  // Enter on a trust dialog accepts its default. Questions are never typed into,
  // and that rule outranks getting the handoff delivered.
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_SCREEN = "Do you trust the files in this folder?";
  env.HANDOFF_NUDGE_MS = "50";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.needsAttention, true);
  assert.ok(
    !readCalls(calls).some((c) => c[0] === "agent" && c[1] === "send-keys"),
    "must not answer the dialog on the user's behalf"
  );
});

test("a marker wrapped one character per line is still found", async () => {
  // A few-column pane wraps mid-word, so the capture reads "- - e n d o f h a n d
  // o f f". Measured in a narrow split: the prompt had been delivered and the agent
  // was working on it, and the handoff was reported as a failure anyway.
  const { env } = workspace();
  const wrapped = briefing.SENTINEL.split("").join("\n");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "narrow-")), "s.txt");
  fs.writeFileSync(file, `${wrapped}\n`);

  env.FAKE_SCREEN_FILE = file;
  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true, out.message);
});

test("a target that never echoes the prompt is confirmed by working on it", async () => {
  // Measured: Grok truncates a long message in its own transcript to
  // "You 6:18 PM are taki …" while working on it for minutes. No marker can ever be
  // found there, and calling that a failure is wrong.
  const { env } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";            // the screen never shows the prompt
  env.HANDOFF_FAKE_BUSY_AFTER_PROMPT = "1";     // idle before it, working on it after
  env.HANDOFF_NUDGE_MS = "20";
  env.HANDOFF_CONFIRM_WINDOW_MS = "100";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.message, MESSAGES.success("pi", "Claude Code", "split"));
});

test("a silent idle target is still a failure, not a handoff", async () => {
  // Busy is the whole basis of that fallback. An agent that shows nothing and does
  // nothing has not taken the handoff.
  const { env } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_STATUS = "idle";
  env.HANDOFF_FAKE_NO_SEQ = "1";
  env.HANDOFF_NUDGE_MS = "20";
  env.HANDOFF_CONFIRM_WINDOW_MS = "100";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.promptFailed("Claude Code"));
});

test("a busy target that is still signing in is not confirmed by being busy", async () => {
  // Antigravity churns through states while it signs in. Its screen says so, and
  // that has to win over the busy fallback or the old false "Handoff started"
  // comes straight back.
  const { env } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_STATUS = "working";
  env.HANDOFF_FAKE_SCREEN = "Verifying your account... please try again shortly.";
  env.HANDOFF_NUDGE_MS = "20";
  env.HANDOFF_CONFIRM_WINDOW_MS = "100";
  env.HANDOFF_DELIVERY_ATTEMPTS = "1";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false, "a signing-in agent has not accepted anything");
});

test("a target already working when the prompt arrives is not confirmed by that", async () => {
  // The busy fallback accepts only a transition the submission caused. An agent
  // already busy was busy with something else, which is how "the agent changed
  // state" used to announce handoffs that had not happened.
  const { env } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_STATUS = "working";   // busy the whole time, before and after
  env.HANDOFF_NUDGE_MS = "20";
  env.HANDOFF_CONFIRM_WINDOW_MS = "100";
  env.HANDOFF_DELIVERY_ATTEMPTS = "1";

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false, "already-busy is not evidence of anything");
});

test("a banner above the input box explains a failure even though it did not delay one", async () => {
  // Antigravity draws its input box while "We're finishing verifying your account
  // eligibility. Please try again shortly." is still above it, then discards
  // whatever is typed. Readiness reads from the input line down, so that banner
  // never delays a handoff - but once delivery has failed it is the reason, and the
  // target deserves the same wait as any other that is still starting up.
  const { env } = workspace();
  env.HANDOFF_FAKE_REACTS = "never";
  env.HANDOFF_FAKE_SCREEN = [
    "⚠️Verifying your account...",
    " └ We're finishing verifying your account eligibility.",
    "   This usually takes a moment. Please try again shortly.",
    "────────────────",
    ">",
    "────────────────",
    "? for shortcuts",
  ].join("\n");
  env.HANDOFF_NUDGE_MS = "20";
  env.HANDOFF_CONFIRM_WINDOW_MS = "80";
  env.HANDOFF_DELIVERY_ATTEMPTS = "2";

  // Readiness is not delayed by it: the banner sits above a drawn input line.
  assert.equal(startingUp(env.HANDOFF_FAKE_SCREEN), false);

  const out = await run({ destination: "split", env, pickerChoice: { selected: "agy" } });
  assert.equal(out.ok, false, "nothing was delivered, so nothing is announced");
  assert.equal(out.message, MESSAGES.promptFailed("Antigravity CLI"));
});

test("an agent that exits leaving its pane behind is reported, not passed over", async () => {
  // Measured: opencode 1.18.5 crashes on startup on this machine and dumps a Bun
  // crash report, leaving the shell prompt back in the pane. Treated as the user
  // closing the pane, the handoff went silent and looked like it had done nothing.
  const { env } = workspace();
  env.HANDOFF_FAKE_FAIL = "agent read";          // the agent is gone
  env.HANDOFF_FAKE_ERROR_CODE = "agent_not_found";
  // `pane get` still answers, so the pane itself survived.

  const out = await run({ destination: "split", env, pickerChoice: { selected: "claude" } });
  assert.equal(out.ok, false);
  assert.equal(out.agentExited, true);
  assert.equal(out.message, MESSAGES.agentExited("Claude Code"));
});
