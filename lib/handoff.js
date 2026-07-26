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
const { SqliteUnavailable, exportPathFor } = require("./source-sqlite.js");

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
  notReady: (name) =>
    `${name} is still finishing its own startup and is not accepting input yet. Nothing was left in it — re-run the handoff once it is ready.`,
  agentExited: (name) =>
    `Handoff failed: ${name} exited before accepting the handoff. Source pane untouched.`,
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
    // Grace given to an agent that submits a pasted prompt by itself, before the
    // one Enter is spent on an agent that leaves it in the composer.
    nudge: num("HANDOFF_NUDGE_MS", 2500),
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

// Collapse whitespace only where a phrase or marker is being matched. A TUI wraps
// text across lines, so a marker can arrive with a newline in the middle of it and
// only flattened text will contain it.
//
// This is deliberately not applied inside readScreen. Doing that is what made the
// line-shaped readiness rules unreachable: measured on live panes, raw captures
// carried 52 (pi) and 37 (agy) newlines and the flattened strings carried zero.
const flat = (text) => String(text || "").replace(/\s+/g, " ");

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
  return showsMarker(text, markers);
}

// A narrow pane wraps mid-word, one character per line, so the capture comes back
// as "o m m i t t e d  w o r k s p a c e" and collapsing runs of whitespace to a
// single space is not enough. Measured in a few-column split: the prompt had been
// delivered and the agent was working on it, and the marker was not found.
// Matching also ignores whitespace entirely, on both sides.
const squash = (text) => String(text || "").replace(/\s+/g, "");
const showsMarker = (screen, markers) => {
  const flattened = flat(screen);
  const squashed = squash(screen);
  return markers.some(
    (marker) => flattened.includes(flat(marker)) || squashed.includes(squash(marker))
  );
};

// Busy now, and still busy a moment later. A single reading is worthless — a
// settling target changes state on its own — but a target that stays busy while
// its screen shows neither a startup notice nor a question is working on something,
// and the only thing it was just given is the handoff.
function agentStatus(call, paneId) {
  try {
    return call(["agent", "get", paneId]).agent.agent_status;
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed");
    return "unknown";
  }
}

async function busyFor(call, paneId, ms, statusBefore) {
  // Only a transition *we* caused counts. An agent already working when the prompt
  // was submitted was working on something else, and a settling agent moves in and
  // out of working on its own — which is exactly how "the agent changed state" once
  // announced handoffs that had not been delivered.
  if (statusBefore === "working") return false;
  const busy = () => agentStatus(call, paneId) === "working";
  if (!busy()) return false;
  await sleep(ms);
  const screen = readScreen(call, paneId);
  if (usable(screen) && (startingUp(screen) || needsAnswer(screen))) return false;
  return busy();
}

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
    if (usable(screen) && showsMarker(screen, markers)) return true;
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
    return out;
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
  // Codex's trust dialog, captured live. Its wording never says "trust" in the
  // part of the screen that survives into the capture — what identifies it is the
  // numbered choice and the key it is waiting on.
  "press enter to continue", "1. yes, continue",
];

const matches = (screen, phrases) => {
  if (!screen) return false;
  const lower = screen.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
};

// "What is the target showing right now" is the tail of the screen, not its whole
// history. Antigravity's "Verifying your account…" notice stays in the transcript
// long after it stops being true, and matching the whole capture left the target
// permanently "starting up": one handoff waited out the entire 180s cap before
// sending, having been ready within seconds.
const CURRENT_VIEW_CHARS = 400;
const tailOf = (screen) =>
  typeof screen === "string" ? screen.slice(-CURRENT_VIEW_CHARS) : screen;

// An agent's input box means it is waiting for input, so a startup notice drawn
// *above* it is scrollback and a notice *below* it is current state.
//
// Detection has to be line-shaped and border-tolerant, because the marker is
// usually not the first character on its line. Captured from live panes: Claude
// Code draws "───────────❯            ───────────" and Grok draws
// "│ >                   │" inside a box. Only the bottom of the screen is
// considered, so a markdown blockquote in the agent's own output cannot pose as
// an input box.
const TAIL_LINES = 8;
const PROMPT_GLYPHS = [">", "❯", "›", "▶", "»", "⏵", "$", "%", "#"];
const BORDER_CHARS = "\\s\\u2500-\\u257f\\u2580-\\u259f\\u2022\\u00b7";
const BORDER = new RegExp(`^[${BORDER_CHARS}]+|[${BORDER_CHARS}]+$`, "g");

function inputLineIndex(lines) {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < TAIL_LINES; i -= 1) {
    const core = lines[i].replace(BORDER, "");
    if (core === "") continue;
    seen += 1;
    if (PROMPT_GLYPHS.some((glyph) => core.startsWith(glyph))) return i;
  }
  return -1;
}

function startingUp(screen) {
  if (typeof screen !== "string" || screen === "") return false;
  const lines = screen.split("\n");
  const i = inputLineIndex(lines);
  // No box found — including a capture with no newlines at all, which is what Grok
  // returns — keeps the character tail. Unknown agents therefore degrade to the
  // previous behaviour rather than breaking.
  if (i === -1) return matches(flat(tailOf(screen)), NOT_READY);
  return matches(flat(lines.slice(i).join("\n")), NOT_READY);
}

const needsAnswer = (screen) => matches(flat(tailOf(screen)), NEEDS_ANSWER);

class TargetNeedsAttention extends Error {}

// Distinct from a question. The target is not refusing the handoff, it simply has
// not finished starting; telling the user to "answer it" sends them looking for a
// dialog that is not there.
class TargetNotReady extends Error {}

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
      throw new TargetNotReady(
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

  // Noted before submitting, so a later "working" can be attributed to the prompt
  // rather than to whatever the target was already doing.
  const statusBefore = agentStatus(call, paneId);

  try {
    call(["agent", "prompt", paneId, text]);
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed before the prompt was sent");
    throw err;
  }

  // `agent prompt` delivers a large multi-line prompt as a bracketed paste, and
  // several agents put it in the composer without submitting it. Measured: Claude
  // Code sat at "❯ [Pasted text #1 +74 lines]" and Codex at
  // "› [Pasted Content 6999 chars]", both reporting idle, still unsent twenty
  // seconds later. One Enter submits it and the agent starts work.
  //
  // pi submits on its own, so the Enter is only spent when nothing has happened —
  // the marker is given a short grace period first. It is never spent on a target
  // showing a question, because Enter would answer it: on a trust dialog that
  // accepts the default.
  if (!(await confirmDelivery(call, paneId, markers, t.nudge))) {
    const parked = readScreen(call, paneId);
    if (usable(parked) && !needsAnswer(parked)) {
      try {
        call(["agent", "send-keys", paneId, "enter"], { json: false });
        log("the prompt was left unsent in the composer; submitted it with one Enter");
      } catch (err) {
        if (isMissing(err)) throw new TargetGone("target closed before the prompt was submitted");
        log(`could not submit the parked prompt: ${describeError(err)}`);
      }
    }
  }

  if (await confirmDelivery(call, paneId, markers, t.confirmWindow)) {
    // Seeing the text is not the same as the agent keeping it. Antigravity echoes
    // a prompt into its input box and then discards it if its account check is
    // still running: measured, the marker appeared 117ms after submission and was
    // gone six seconds later, with "Verifying your account… please try again
    // shortly" in its place. So the confirmation has to survive a moment.
    await sleep(t.persist);
    const after = readScreen(call, paneId);
    const stillThere = usable(after) && showsMarker(after, markers);

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
    log(`target screen at failure: ${flat(why).slice(-200)}`);
    if (needsAnswer(why)) {
      throw new TargetNeedsAttention("the target is waiting on you, not on the handoff");
    }
    // Still starting up: worth another pass once it has finished.
    if (startingUp(why)) return { discarded: true };

    // Readiness reads only from the input line down, so a banner above it never
    // delays a handoff. Explaining a failure is the other way round: Antigravity
    // draws its input box while "We're finishing verifying your account eligibility…
    // Please try again shortly" is still above it, and then discards whatever is
    // typed. Once delivery has demonstrably failed, that banner is the reason, and
    // it earns the same wait-and-retry as any target still starting up.
    if (matches(flat(tailOf(why)), NOT_READY)) {
      log("the target's screen still carries a startup notice; waiting for it");
      return { discarded: true };
    }

    // Some agents never put the prompt on screen to be found. Measured: Grok
    // truncates a long message in its own transcript to "You 6:18 PM are taki …",
    // eight characters, while working on it for minutes with its context counter
    // at 18K/500K. Reporting that as a failure is simply wrong.
    //
    // This is the one place a state is accepted as proof, and only with the screen
    // saying nothing against it: not starting up, not asking anything, and busy —
    // twice, a persistence apart, so a moment's churn does not qualify. Antigravity
    // is not let through here, because while it signs in its screen says so and the
    // startingUp check above claims it first.
    if (await busyFor(call, paneId, t.persist, statusBefore)) {
      log("no echo to find; confirmed by the target working on it instead");
      return { delivered: true };
    }
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

  // 5. Measure the session, re-resolving so the capture is as fresh as possible.
  //    Nothing is written: the transcript either travels inside the prompt or is
  //    read by the target from where its own agent put it.
  let session;
  try {
    resolved = resolveSource();
    session = snapshot.measure({ resolved });
  } catch (err) {
    const message = err instanceof SqliteUnavailable && /node:sqlite/.test(err.message)
      ? MESSAGES.needsNode225
      : MESSAGES.noContext;
    notify(call, message);
    return { ok: false, message };
  }

  meta.snapshotUtc = new Date().toISOString();
  let built = briefing.build({ meta, session });
  if (!built) {
    notify(call, MESSAGES.noContext);
    return { ok: false, message: MESSAGES.noContext };
  }

  // opencode's only store is a single database with no per-session files, measured
  // at 304 MiB, so a session too large to inline has to be materialised. This is
  // the one place the plugin writes anything: one file, named for the session, in
  // opencode's own data directory, overwritten on each handoff of that session.
  if (built.mode === "reference" && session.strategy === "sqlite") {
    const exportPath = exportPathFor(resolved.dbPath, resolved.sessionId);
    try {
      fs.writeFileSync(exportPath, session.body);
    } catch (err) {
      log(`opencode export failed: ${describeError(err)}`);
      notify(call, MESSAGES.noContext);
      return { ok: false, message: MESSAGES.noContext };
    }
    built = briefing.build({ meta, session: { ...session, nativePath: exportPath } });
    if (!built) {
      notify(call, MESSAGES.noContext);
      return { ok: false, message: MESSAGES.noContext };
    }
  }

  if (dryRun) {
    return { ok: true, message: "", prompt: built.text, mode: built.mode, request, meta };
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
  try {
    // The markers are the sentinel that ends every prompt, plus — in reference mode
    // — the basename of the file the target was told to read, which survives the
    // path elision agents apply to long absolute paths.
    await deliverPrompt(
      call,
      targetPaneId,
      built.text,
      env,
      built.markers,
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
      // The pane going too means the user closed it: the handoff worked and they
      // moved on, so saying it failed would be a lie. But a pane that is still
      // there with no agent in it means the agent itself exited, and that is worth
      // saying. Measured: opencode 1.18.5 crashes on startup on this machine with a
      // Bun crash report, leaving the shell prompt back in the pane; reported as a
      // user closing the pane, it looked like the handoff had silently done nothing.
      let paneSurvives = false;
      try {
        paneSurvives = Boolean(call(["pane", "get", targetPaneId]).pane);
      } catch {
        paneSurvives = false;
      }
      if (paneSurvives) {
        log(`the target agent exited: ${describeError(err)}`);
        const message = MESSAGES.agentExited(targetName);
        notify(call, message);
        return { ok: false, message, agentExited: true, prompt: built.text, mode: built.mode, targetPaneId };
      }
      log("target pane closed while confirming delivery; nothing to report");
      return { ok: true, message: "", prompt: built.text, mode: built.mode, targetPaneId, closed: true };
    }
    // The target never finished starting. Nothing was delivered and nothing was
    // left behind, and it is worth re-running rather than investigating.
    if (err instanceof TargetNotReady) {
      log(`not delivered: ${describeError(err)}`);
      const message = MESSAGES.notReady(targetName);
      notify(call, message);
      return { ok: false, message, notReady: true, prompt: built.text, mode: built.mode, targetPaneId };
    }
    // The target asked the user something and was deliberately left alone.
    if (err instanceof TargetNeedsAttention) {
      log(`not delivered: ${describeError(err)}`);
      const message = MESSAGES.needsAttention(targetName);
      notify(call, message);
      return { ok: false, message, needsAttention: true, prompt: built.text, mode: built.mode, targetPaneId };
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
  return { ok: true, message, prompt: built.text, mode: built.mode, targetPaneId, agentName };
}

module.exports = {
  run, MESSAGES, shellIsAtPrompt, startingUp, needsAnswer, usable, flat,
  inputLineIndex, NOT_READY, NEEDS_ANSWER,
  // Exposed so a test can prove the screen reaches the readiness rules with its
  // newlines intact, driven through the fake CLI rather than a hand-built literal.
  readScreenForTest: readScreen,
  // Exposed so the delivery path can be exercised against a real agent without
  // driving a whole handoff.
  deliverPromptForTest: deliverPrompt,
};
