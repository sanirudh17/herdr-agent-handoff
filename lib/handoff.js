"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agents = require("./agents.js");
const briefing = require("./briefing.js");
const herdr = require("./herdr.js");
const ipc = require("./ipc.js");
const paths = require("./paths.js");
const snapshot = require("./snapshot.js");
const sources = require("./sources.js");
const keybindings = require("./keybindings.js");
const theme = require("./theme.js");
const { SqliteUnavailable } = require("./source-sqlite.js");

const MESSAGES = {
  notAgentPane: "Handoff unavailable: the active pane is not a running agent.",
  noContext:
    "Full handoff unavailable: complete session context could not be retrieved for this source agent.",
  needsNode225:
    "Full handoff unavailable: reading opencode's session store requires Node 22.5 or newer.",
  targetCreateFailed: (dest) =>
    `Handoff failed: could not create the target ${dest}. Source pane untouched.`,
  startFailed: (name) => `Handoff failed: ${name} did not start. Source pane untouched.`,
  promptFailed: (name) =>
    `Handoff failed: ${name} started but did not accept the handoff. Source pane untouched.`,
  startingUp: (name) => `${name} is still starting up — the handoff will be delivered when it is ready.`,
  needsAttention: (name) =>
    `${name} is asking you something first. Answer it and re-run the handoff — nothing was typed into it.`,
  success: (src, tgt, dest) => `Handoff started: ${src} → ${tgt} (${dest})`,
};

// HANDOFF_FAKE_SCRIPT is the single test seam: it prepends a stand-in script to
// every argv. It is never set in production.
function cli(env) {
  const prefix = env.HANDOFF_FAKE_SCRIPT ? [env.HANDOFF_FAKE_SCRIPT] : [];
  return (args, opts = {}) => herdr.run([...prefix, ...args], { env, ...opts });
}

function notify(call, title) {
  try {
    call(["notification", "show", title]);
  } catch {
    // a failed toast must not mask the underlying outcome
  }
}

function context(env) {
  try {
    return JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function destLabel(destination) {
  return destination === "tab" ? "new tab" : "split";
}

// Herdr's own labels, not its internal ids. workspace_label is what the sidebar
// shows; tab_label is what the tab bar shows.
function workspaceName(ctx, pane) {
  return ctx.workspace_label || pane.workspace_id;
}

// The user's Herdr theme, so the picker renders in the same colours as Herdr's
// own settings modal.
function resolveTheme(env, call) {
  let help = "";
  try {
    help = call(["--help"], { json: false });
  } catch {
    // fall back to the env var / documented default below
  }
  return theme.resolveTheme(keybindings.findConfigPath({ env, helpOutput: help }));
}

function describePlace(ctx, pane) {
  const workspace = workspaceName(ctx, pane);
  const tab = ctx.tab_label;
  return tab ? `${workspace} · tab ${tab}` : workspace;
}

function uniqueAgentName(call, kind) {
  let existing = [];
  try {
    const result = call(["agent", "list"]);
    existing = (result.agents || []).map((a) => a.name).filter(Boolean);
  } catch {
    existing = [];
  }
  const base = `handoff-${kind}`;
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now() % 1000}`;
}

const START_TIMEOUT_MS = 60000;
const SHELL_TIMEOUT_MS = 10000;
// When a target is still starting up after this long, say so, rather than leaving
// the user watching a silent pane and concluding the handoff failed.
const SLOW_NOTICE_MS = 6000;
// Delivery timings, overridable so the tests need not wait out real ones.
function timings(env) {
  const num = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    // Let a freshly started agent finish drawing its input box before typing at it.
    settle: num("HANDOFF_SETTLE_MS", 800),
    // How long the target's screen must hold still before it counts as ready.
    // A short stillness check, not a demand for a byte-identical screen: spinners
    // and token counters mean many agents never hold one, and waiting for that was
    // what turned every handoff into a ninety-second stare.
    // Measured from the first painted frame, not from launch. opencode paints
    // nothing for five seconds and then holds perfectly still, so stillness is a
    // good signal — but only once there is something to be still.
    still: num("HANDOFF_STILL_MS", 2500),
    grace: num("HANDOFF_GRACE_MS", 8000),
    readyCap: num("HANDOFF_READY_CAP_MS", 180000),
    // All three delivery signals fire well under a second in practice, so this is
    // a backstop rather than an expected wait. The long waiting happens in the
    // readiness gate, where it belongs.
    confirmWindow: num("HANDOFF_CONFIRM_WINDOW_MS", 30000),
    // How long a confirmed prompt must stay put before it counts as accepted.
    persist: num("HANDOFF_PERSIST_MS", 3000),
    // Passes allowed, and only ever spent on a prompt seen to be discarded. Never
    // a blind retry: those duplicate the handoff.
    attempts: num("HANDOFF_DELIVERY_ATTEMPTS", 3),
  };
}

// `herdr agent start` is unusable on Windows when the agent takes no extra
// arguments. Herdr builds the launch line as
//   $p=Start-Process -FilePath <program> -ArgumentList <args> ...
// (src/platform/windows.rs), and with no args that renders `-ArgumentList ''`,
// which PowerShell rejects outright:
//   "Cannot validate argument on parameter 'ArgumentList'. The argument is null
//    or empty."
// The agent never launches. It is argv-independent, so it hits every kind.
//
// On Windows the agent is therefore launched the way a person would - typed at
// the pane's own prompt via `pane run` - and Herdr's normal screen detection
// picks it up, exactly as it does for an agent the user started by hand. The
// documented path is kept everywhere else so this workaround disappears on its
// own once Herdr is fixed.
// Progress goes to stdout, which Herdr captures per action in
// `herdr plugin log list`. Without it a failed launch reports only "did not
// start" and gives no way to tell which step gave up.
const startedAt = Date.now();
function log(message) {
  process.stdout.write(`[handoff +${Date.now() - startedAt}ms] ${message}\n`);
}

const describeError = (err) => (err && err.message ? err.message : String(err));

// HANDOFF_AGENT_START forces a strategy so both paths are testable on any OS.
function windowsAgentStartIsBroken(env) {
  if (env.HANDOFF_AGENT_START === "native") return false;
  if (env.HANDOFF_AGENT_START === "pane-run") return true;
  return process.platform === "win32";
}

// The executable name that actually resolved on PATH; the pane's shell resolves
// it the same way availability detection did.
function launchCommand(definition, kind) {
  return (definition && definition.execName) || kind;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for Herdr to notice an agent in the pane, then for it to become idle.
// `agent wait` needs the pane to already be recognised as an agent, so the
// detection step is polled first.
// `pane run` types at the pane's shell prompt, so the shell has to actually be
// at one. A pane created a moment ago may still be starting, and input sent then
// is simply lost. Herdr makes the same demand of `agent start`: "The pane must be
// at its interactive shell prompt."
// The shell owns the prompt when nothing else is in the foreground. On Windows a
// shell at its prompt still lists *itself* as the foreground process, so an empty
// list is the wrong test — "only the shell" is the right one.
function shellIsAtPrompt(processInfo) {
  const info = processInfo || {};
  if (!info.shell_pid) return false;
  const foreground = info.foreground_processes || [];
  if (foreground.length === 0) return true;
  return foreground.every((p) => p.pid === info.shell_pid);
}

async function waitForShellPrompt(call, paneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (shellIsAtPrompt(call(["pane", "process-info", "--pane", paneId]).process_info)) {
        return true;
      }
    } catch (err) {
      log(`process-info not ready: ${describeError(err)}`);
    }
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

async function waitForDetection(call, paneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "none";
  for (;;) {
    try {
      const pane = call(["pane", "get", paneId]).pane;
      if (pane.agent) {
        log(`detected ${pane.agent} in ${paneId} (status ${pane.agent_status})`);
        return true;
      }
      lastSeen = `agent=null status=${pane.agent_status}`;
    } catch (err) {
      lastSeen = describeError(err);
    }
    if (Date.now() >= deadline) {
      log(`detection timed out; last saw ${lastSeen}`);
      return false;
    }
    await sleep(250);
  }
}

async function startAgent(call, { name, kind, paneId, command, env }) {
  if (!windowsAgentStartIsBroken(env)) {
    log(`agent start ${kind} in ${paneId}`);
    call([
      "agent", "start", name, "--kind", kind,
      "--pane", paneId, "--timeout", String(START_TIMEOUT_MS),
    ]);
    return;
  }

  log(`waiting for the shell prompt in ${paneId}`);
  if (!(await waitForShellPrompt(call, paneId, SHELL_TIMEOUT_MS))) {
    log("shell prompt never settled; running the command anyway");
  }

  log(`launching "${command}" in ${paneId} via the pane shell`);
  // `pane run` answers through send_ok_request: exit 0 and no stdout at all.
  // Demanding a JSON envelope from it reported a perfectly good launch as a
  // failure, which is what produced "did not start" for every agent on Windows.
  call(["pane", "run", paneId, command], { json: false });

  if (!(await waitForDetection(call, paneId, START_TIMEOUT_MS))) {
    throw new Error(`${kind} was not detected in ${paneId}`);
  }

  // Any of these means the agent is up and no longer starting. "idle" alone is
  // too strict: a first run often opens on a trust-this-folder prompt, which is
  // "blocked", and that is still a successfully started agent.
  try {
    call(["agent", "wait", paneId, "--until", "idle", "--until", "done",
      "--until", "blocked", "--timeout", String(START_TIMEOUT_MS)]);
  } catch (err) {
    log(`readiness wait failed: ${describeError(err)}`);
    throw err;
  }

  try {
    call(["agent", "rename", paneId, name]);
  } catch {
    // A missing name only costs a nicer sidebar label.
  }
}

// A freshly launched agent reports itself ready while its TUI is still painting,
// and text typed into a half-drawn input box is simply swallowed — the handoff
// said "started" while the target sat at an empty prompt.
//
// `agent prompt --wait` is the cure: Herdr requires an observed state change
// within 5s of submission and returns `agent_prompt_stalled` when none comes, so
// a swallowed prompt is detectable rather than silent. A stall is the one case
// worth retrying, because it means nothing landed.
// Every agent record carries `state_change_seq`, which Herdr bumps on each
// lifecycle transition. That counter is the ground truth for "did this agent react
// to what I sent", independent of how `agent prompt --wait` chooses to report
// itself — and a wait that errors is emphatically not proof of non-delivery: pi
// visibly accepted a prompt and started working while the wait reported failure.
function agentSnapshot(call, paneId) {
  try {
    const agent = call(["agent", "get", paneId]).agent || {};
    return { seq: agent.state_change_seq || 0, status: agent.agent_status || "unknown" };
  } catch {
    return null;
  }
}

class TargetGone extends Error {}

const isMissing = (err) =>
  Boolean(err) && (err.code === "agent_not_found" || err.code === "pane_not_found");

// Collapsing whitespace makes the search immune to how the target's TUI wrapped
// or reflowed the text it echoed.
const normalize = (text) => String(text || "").replace(/\s+/g, " ");

// Reading the *target's* own screen is the only proof that our prompt reached it.
// A state change is not enough: Antigravity churns through several states while
// signing in, which looked exactly like a reaction to a prompt it had actually
// swallowed. This never touches the source pane, whose scrollback remains off
// limits — the transferred context still comes only from the native session file.
//
// One reader, used by both the readiness gate and the delivery check: having two
// copies is how the json:false fix could have been applied to one and missed on
// the other.
function targetShows(call, paneId, markers) {
  const text = readScreen(call, paneId);
  if (text === null) return false;
  return markers.some((marker) => text.includes(normalize(marker)));
}

// Deliberately not exported as a delivery signal any more. Kept only as a note:
// a state change after submission proved worthless, because a target that is
// still settling changes state on its own.

// Delivery is proven by the prompt itself appearing on the target's screen, and
// by nothing weaker.
//
// Looser signals were tried and are wrong. "The screen changed since submission"
// and "the agent changed state" both sound safe once the target has settled, and
// both produced handoffs announced as started with nothing delivered: Antigravity
// prints "Verifying your account…" seconds after its screen has gone quiet, and
// that late redraw is indistinguishable from a reply. Announcing a handoff that
// did not happen is the worst outcome available here, so the bar is evidence of
// the text and nothing else.
//
// A target that turns out to be unable to run is reported as such rather than
// waited out, so the reason reaches the user instead of a generic timeout.
async function confirmDelivery(call, paneId, markers, windowMs) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const screen = readScreen(call, paneId);
    if (usable(screen)) {
      if (markers.some((marker) => screen.includes(normalize(marker)))) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(300);
  }
}

// `herdr agent read` prints the screen as plain text, with no JSON envelope, so it
// must be read with json:false. Asking for JSON made every single read throw and
// return null: delivery could never be confirmed, so each handoff waited out its
// whole confirmation window and then reported a failure for a prompt that had in
// fact arrived. The same silence disabled the trust-gate check.
function readScreen(call, paneId) {
  try {
    const out = call(
      ["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "400"],
      { json: false },
    );
    return normalize(out);
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed");
    log(`screen read failed: ${describeError(err)}`);
    return null;
  }
}

// Phrases an agent shows while it is starting up and discarding input. Waiting on
// "screen stopped changing" alone was far too slow: spinners, token counters and a
// blinking cursor mean many agents never hold a byte-identical screen, so every
// handoff sat out the whole cap — the minute-and-a-half that looked like a hang.
const NOT_READY = [
  "signing in", "sign in to", "logging in", "log in to", "authenticating",
  "authorizing", "verifying your account", "verifying account", "try again shortly",
  "waiting for browser", "opening browser", "initializing",
  "starting up", "loading model", "please wait",
];

// There is deliberately no "this agent cannot run" list.
//
// An earlier version treated "out of credits" in Antigravity's footer as proof
// the target could not run, and refused the handoff. That was wrong: the footer
// reports a usage-credit tier, and the agent falls back to another allowance and
// keeps working. Capability cannot be read off a status line, and guessing it
// would block handoffs to a perfectly healthy agent. Whether an agent accepts the
// work is settled by watching what it does with the prompt, not by reading its
// chrome.

// A pane that reads as nothing is not a calm agent, it is an agent whose TUI has
// not painted yet. Measured on opencode: the pane reads 0 characters for the
// first five seconds while Herdr reports "idle" throughout, then jumps to a
// stable 346. Treating empty-and-unchanging as settled is what submitted the
// handoff into a pane that could not receive it — and made the blank-to-painted
// transition afterwards look like the agent responding.
const usable = (screen) => typeof screen === "string" && screen.length > 0;

// A question on screen is not merely "not ready" — it is a reason never to type.
// Antigravity opens a folder-trust gate on its first run in a directory, and
// sending a prompt into that dialog does not queue a handoff: at best the text is
// discarded, at worst the Enter that follows it answers the dialog on the user's
// behalf. Nothing is ever submitted while one of these is showing.
const NEEDS_ANSWER = [
  "do you trust", "trust this folder", "trust this directory", "trust the files",
  "requesting permission for", "do you want to proceed", "allow once",
  "yes, proceed", "[y/n]", "press enter to confirm",
  // A first run may not be signed in at all. Antigravity opens a login menu -
  // "Select login method: > 1. Google OAuth" - and a prompt typed into that is
  // read as a menu choice: it launched an OAuth attempt that then failed with
  // "token exchange failed". Menus are questions too.
  "select login method", "use arrow keys to navigate", "press any key to",
  "sign in to continue", "choose a login",
];

const matches = (screen, phrases) => {
  if (!screen) return false;
  const lower = screen.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
};

// "What is the target showing right now" is the tail of the screen, not its whole
// history. Antigravity's "Verifying your account…" notice stays in the transcript
// after it stops being true, and matching against the full capture left the target
// permanently "starting up": one handoff waited out the entire 180s cap before
// sending, having been ready within seconds.
const CURRENT_VIEW_CHARS = 400;
const tailOf = (screen) =>
  typeof screen === "string" ? screen.slice(-CURRENT_VIEW_CHARS) : screen;

const startingUp = (screen) => matches(tailOf(screen), NOT_READY);
const needsAnswer = (screen) => matches(tailOf(screen), NEEDS_ANSWER);

class TargetNeedsAttention extends Error {}

// Three conditions, in order of authority:
//
//  1. Herdr's own status. "blocked" is precisely "this agent is waiting on the
//     user" — its detection manifests carry visible_blocker rules for exactly
//     these dialogs — and "working" means it is mid-turn. Only "idle" is ready.
//  2. No question on screen, as a backstop for dialogs Herdr's rules do not
//     recognise. Antigravity's first-run folder-trust gate is one of them.
//  3. Not visibly starting up, and briefly settled.
//
// A target still waiting on the user when the cap expires is never typed into.
// Answering someone's trust dialog by accident is far worse than a late handoff.
async function waitUntilReady(call, paneId, opts) {
  const { stillMs, graceMs, capMs, onSlow, onAttention } = opts;
  const started = Date.now();
  const deadline = started + capMs;
  let last = readScreen(call, paneId);
  let since = Date.now();
  let firstPainted = usable(last) ? Date.now() : Infinity;
  let warnedSlow = false;
  let warnedAttention = false;

  for (;;) {
    const snapshot = agentSnapshot(call, paneId);
    const status = snapshot ? snapshot.status : "unknown";
    const painted = usable(last);
    const blocked = status === "blocked" || needsAnswer(last);
    const busy = status === "working" || startingUp(last);
    // The grace period only starts counting once the TUI has painted; before
    // that there is nothing to be stable about.
    const stable = painted && Date.now() - since >= stillMs;

    if (painted && !blocked && !busy &&
        (stable || Date.now() - firstPainted >= graceMs)) {
      log(`target ready after ${Date.now() - started}ms`);
      return;
    }

    const elapsed = Date.now() - started;
    if (blocked && !warnedAttention && elapsed >= SLOW_NOTICE_MS) {
      warnedAttention = true;
      log("target is waiting on the user (permission or trust prompt)");
      if (onAttention) onAttention();
    } else if (!blocked && busy && !warnedSlow && elapsed >= SLOW_NOTICE_MS) {
      warnedSlow = true;
      if (onSlow) onSlow();
    }

    if (Date.now() >= deadline) {
      if (blocked) {
        throw new TargetNeedsAttention(
          "the target is waiting on a prompt of its own and was never typed into"
        );
      }
      log("target never settled; sending anyway");
      return;
    }

    await sleep(400);
    const now = readScreen(call, paneId);
    if (now !== null && now !== last) {
      last = now;
      since = Date.now();
      if (usable(now) && firstPainted === Infinity) firstPainted = Date.now();
    }
  }
}

// A freshly launched agent reports itself ready while its TUI is still painting —
// and some, like Antigravity, sign in for a minute or two first. Text typed at a
// half-drawn input box is swallowed silently, which is why a handoff could report
// success over an empty prompt.
async function deliverPrompt(call, paneId, text, env, markers, hooks = {}) {
  const t = timings(env);
  await sleep(t.settle);

  // Sending again is normally forbidden — Antigravity buffers text typed while it
  // finishes signing in and flushes the lot, so six blind retries once put five
  // copies of one handoff into it. The single exception is a prompt observed to
  // have been echoed and then thrown away: that text demonstrably did not survive,
  // so re-sending it cannot duplicate anything.
  for (let attempt = 1; attempt <= t.attempts; attempt += 1) {
    const outcome = await submitOnce(call, paneId, text, env, markers, hooks, t);
    if (outcome.delivered) return;
    if (attempt >= t.attempts) {
      throw new TargetNeedsAttention(
        "the target kept discarding the prompt while it was still starting up"
      );
    }
    log(`the target discarded the prompt while starting up; waiting for it to finish (attempt ${attempt})`);
  }
}

async function submitOnce(call, paneId, text, env, markers, hooks, t) {
  await waitUntilReady(call, paneId, {
    stillMs: t.still,
    graceMs: t.grace,
    capMs: t.readyCap,
    onSlow: hooks.onSlow,
    onAttention: hooks.onAttention,
  });

  // Last look before typing. Readiness can go stale: Antigravity prints its
  // account-verification notice several seconds after its screen first settles.
  const finalLook = readScreen(call, paneId);
  if (usable(finalLook) && needsAnswer(finalLook)) {
    throw new TargetNeedsAttention("the target put a question up before the prompt was sent");
  }

  try {
    call(["agent", "prompt", paneId, text]);
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed before the prompt was sent");
    throw err;
  }

  if (await confirmDelivery(call, paneId, markers, t.confirmWindow)) {
    // Seeing the text is not the same as the agent keeping it. Antigravity echoes
    // a prompt into its input box and then discards it if its account check is
    // still running: measured, the marker appeared 117ms after submission and was
    // gone six seconds later, with "Verifying your account… please try again
    // shortly" in its place. So the confirmation has to survive a moment.
    await sleep(t.persist);
    const after = readScreen(call, paneId);
    const stillThere = usable(after) && markers.some((m) => after.includes(normalize(m)));

    // Gone *and* the target is back to starting up means it threw the prompt
    // away. Gone while the target is busy just means it has moved on to work.
    if (!stillThere && usable(after) && (startingUp(after) || needsAnswer(after))) {
      return { discarded: true };
    }

    log("prompt confirmed on the target's screen");
    return { delivered: true };
  }

  // Say why, if the target's own screen says why. "Did not accept the handoff"
  // is true but useless; "it is asking you to sign in" is something to act on.
  const why = readScreen(call, paneId);
  if (usable(why)) {
    log(`target screen at failure: ${why.slice(-200)}`);
    if (needsAnswer(why)) {
      throw new TargetNeedsAttention("the target is waiting on you, not on the handoff");
    }
    // Still starting up: worth another pass once it has finished.
    if (startingUp(why)) return { discarded: true };
  }

  throw new Error(
    `the target showed no sign of the prompt within ${Math.round(t.confirmWindow / 1000)}s`
  );
}

async function run(opts) {
  const {
    destination,
    env = process.env,
    dryRun = false,
    pickerChoice = null,
    pickerTimeoutMs = 300000,
  } = opts;

  const call = cli(env);
  const ctx = context(env);
  const sourcePaneId = ctx.focused_pane_id;

  if (!sourcePaneId) {
    notify(call, MESSAGES.notAgentPane);
    return { ok: false, message: MESSAGES.notAgentPane };
  }

  // 1. Read the source pane. This is the only call made against it.
  let pane;
  try {
    pane = call(["pane", "get", sourcePaneId]).pane;
  } catch {
    notify(call, MESSAGES.notAgentPane);
    return { ok: false, message: MESSAGES.notAgentPane };
  }

  if (!pane.agent) {
    notify(call, MESSAGES.notAgentPane);
    return { ok: false, message: MESSAGES.notAgentPane };
  }

  const sourceKind = pane.agent;
  const sourceDef = agents.byKind(sourceKind);
  const sourceName = sourceDef ? sourceDef.name : sourceKind;
  const homedir = env.USERPROFILE || env.HOME || os.homedir();

  const resolveSource = () =>
    sources.resolve({ agent: sourceKind, sessionRef: pane.agent_session, env, homedir });

  // 2. Resolve complete context BEFORE the picker opens, so a handoff that
  //    cannot deliver full history never starts.
  let resolved;
  try {
    resolved = resolveSource();
  } catch {
    notify(call, MESSAGES.noContext);
    return { ok: false, message: MESSAGES.noContext };
  }

  // 3. Build the roster.
  const installedAgents = agents.available(env).map((a) => ({
    kind: a.kind,
    name: a.name,
    isSource: a.kind === sourceKind,
    execName: a.execName,
    executable: a.executable,
  }));
  const installedKinds = new Set(installedAgents.map((a) => a.kind));
  const notInstalled = agents.AGENTS
    .filter((a) => !installedKinds.has(a.kind))
    .map((a) => ({ kind: a.kind, name: a.name }));

  // Describe the source and destination in the labels the user actually sees in
  // Herdr's sidebar and tab bar. Raw ids like "w5:p1" mean nothing to them.
  const place = describePlace(ctx, pane);
  const size = resolved.lines
    ? `${resolved.lines.toLocaleString("en-US")} lines`
    : "session store";
  const contextLine = `${sourceName} in ${place}${size ? ` · ${size}` : ""}`;
  const destinationText = destination === "tab"
    ? `new tab in ${workspaceName(ctx, pane)}`
    : "split beside it";

  const requestsDir = paths.requestsDir(env);
  const id = ipc.newId();
  const requestFile = ipc.requestPath(requestsDir, id);
  const resultFile = ipc.resultPath(requestsDir, id);
  const request = {
    resultPath: resultFile,
    contextLine,
    destination: destinationText,
    installed: installedAgents.map(({ kind, name, isSource }) => ({ kind, name, isSource })),
    notInstalled,
    // Resolved here rather than in the picker: this process already knows how to
    // find Herdr's config, and the picker should stay a pure renderer.
    theme: resolveTheme(env, call),
  };

  const meta = {
    sourceKind,
    sourceName,
    sessionId: (pane.agent_session && pane.agent_session.value) || "",
    sourcePaneId,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    cwd: pane.cwd || ctx.focused_pane_cwd || homedir,
    destination,
    strategy: resolved.strategy,
  };

  // 4. Choose the target.
  let choice = pickerChoice;
  if (!choice && !dryRun) {
    ipc.writeJson(requestFile, request);
    // Pass the plugin root with the Windows verbatim prefix stripped. Herdr would
    // otherwise hand the pane a \\?\ cwd, which Node cannot resolve relative paths
    // against. The manifest command is cwd-independent too; this keeps the pane's
    // cwd usable for anything else running there.
    const openArgs = (placement) => [
      "plugin", "pane", "open",
      "--plugin", "agent-handoff",
      "--entrypoint", "picker",
      ...(placement ? ["--placement", placement] : []),
      "--cwd", paths.pluginRoot(env),
      "--env", `HERDR_HANDOFF_REQUEST=${requestFile}`,
      "--focus",
    ];
    try {
      call(openArgs(null));
    } catch {
      // A popup is only allowed while the UI is in terminal mode. Fall back to
      // an overlay pane. This is a UI fallback only; it never changes what
      // context is transferred.
      try {
        call(openArgs("overlay"));
      } catch {
        ipc.cleanup([requestFile, resultFile]);
        const message = MESSAGES.targetCreateFailed(destLabel(destination));
        notify(call, message);
        return { ok: false, message };
      }
    }
    choice = await ipc.waitForResult(resultFile, { timeoutMs: pickerTimeoutMs });
    ipc.cleanup([requestFile, resultFile]);
  }

  if (!dryRun && (!choice || choice.cancelled || !choice.selected)) {
    return { ok: false, cancelled: true, message: "" };
  }

  const targetKind = (choice && choice.selected) || sourceKind;
  const targetDef = agents.byKind(targetKind);
  const targetName = targetDef ? targetDef.name : targetKind;
  meta.targetKind = targetKind;
  meta.targetName = targetName;

  // 5. Snapshot the session, re-resolving so the capture is as fresh as possible.
  const handoffsDir = paths.handoffsDir(env);
  fs.mkdirSync(handoffsDir, { recursive: true });
  let snap;
  try {
    resolved = resolveSource();
    snap = snapshot.write({ resolved, meta, baseDir: handoffsDir });
  } catch (err) {
    const message = err instanceof SqliteUnavailable && /node:sqlite/.test(err.message)
      ? MESSAGES.needsNode225
      : MESSAGES.noContext;
    notify(call, message);
    return { ok: false, message };
  }

  const handoffPath = path.join(snap.dir, "HANDOFF.md");
  fs.writeFileSync(handoffPath, briefing.render({ snapshot: snap, meta }));
  try {
    fs.chmodSync(handoffPath, 0o444);
  } catch {
    // best effort
  }
  snapshot.prune(handoffsDir);

  if (dryRun) {
    return { ok: true, message: "", handoffDir: snap.dir, request, meta };
  }

  // 6. Create the target.
  let targetPaneId;
  try {
    if (destination === "tab") {
      const tab = call([
        "tab", "create", "--workspace", pane.workspace_id, "--no-focus", "--cwd", meta.cwd,
      ]).tab;
      const panes = call(["pane", "list"]).panes || [];
      const found = panes.find((p) => p.tab_id === tab.tab_id);
      if (!found) throw new Error("new tab has no pane");
      targetPaneId = found.pane_id;
    } else {
      targetPaneId = call([
        "pane", "split", "--pane", sourcePaneId, "--direction", "right",
        "--no-focus", "--cwd", meta.cwd,
      ]).pane.pane_id;
    }
  } catch {
    const message = MESSAGES.targetCreateFailed(destLabel(destination));
    notify(call, message);
    return { ok: false, message };
  }

  // 7. Start the target agent.
  const agentName = uniqueAgentName(call, targetKind);
  const targetDefinition = installedAgents.find((a) => a.kind === targetKind);
  try {
    await startAgent(call, {
      name: agentName,
      kind: targetKind,
      paneId: targetPaneId,
      command: launchCommand(targetDefinition, targetKind),
      env,
    });
  } catch (err) {
    log(`launch failed: ${describeError(err)}`);
    const message = MESSAGES.startFailed(targetName);
    notify(call, message);
    return { ok: false, message, detail: describeError(err) };
  }

  // 8. Deliver the handoff. Addressed by pane id, which always identifies the
  //    agent; the name is only a sidebar label and may not have been applied.
  const kickoff = briefing.kickoff({ sourceName, handoffPath });
  try {
    // "HANDOFF.md" survives the path elision agents apply to long absolute paths;
    // the opening phrase catches agents that echo the prompt verbatim.
    await deliverPrompt(
      call,
      targetPaneId,
      kickoff,
      env,
      ["HANDOFF.md", "Session handoff from"],
      {
        // A silent pane during a slow first-run sign-in reads as a failed handoff.
        onSlow: () => notify(call, MESSAGES.startingUp(targetName)),
        onAttention: () => notify(call, MESSAGES.needsAttention(targetName)),
      },
    );
  } catch (err) {
    // The target being gone is not a failure to report. The pane existed, the
    // agent started, and the user closed it — most likely because the work was
    // already done. Shouting "handoff failed" at that point is just wrong, and it
    // is what happened after a perfectly good Hermes handoff.
    if (err instanceof TargetGone || isMissing(err)) {
      log("target pane closed while confirming delivery; nothing to report");
      return { ok: true, message: "", handoffDir: snap.dir, targetPaneId, closed: true };
    }
    // The target asked the user something and was deliberately left alone.
    if (err instanceof TargetNeedsAttention) {
      log(`not delivered: ${describeError(err)}`);
      const message = MESSAGES.needsAttention(targetName);
      notify(call, message);
      return { ok: false, message, needsAttention: true, handoffDir: snap.dir, targetPaneId };
    }
    log(`delivery failed: ${describeError(err)}`);
    const message = MESSAGES.promptFailed(targetName);
    notify(call, message);
    return { ok: false, message, detail: describeError(err) };
  }

  // 9. Activate the target.
  try {
    call(["agent", "focus", targetPaneId]);
  } catch {
    // the handoff already landed; focus is cosmetic
  }

  const message = MESSAGES.success(sourceName, targetName, destLabel(destination));
  notify(call, message);
  return { ok: true, message, handoffDir: snap.dir, targetPaneId, agentName };
}

module.exports = {
  run, MESSAGES, shellIsAtPrompt, startingUp, needsAnswer, usable,
  NOT_READY, NEEDS_ANSWER,
  // Exposed so the delivery path can be exercised against a real agent without
  // driving a whole handoff.
  deliverPromptForTest: deliverPrompt,
};
