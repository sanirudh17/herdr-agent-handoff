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
    still: num("HANDOFF_STILL_MS", 700),
    grace: num("HANDOFF_GRACE_MS", 2500),
    readyCap: num("HANDOFF_READY_CAP_MS", 180000),
    // The toast is withheld until the prompt is actually visible on the target;
    // announcing "handoff started" over an agent that has not read it is the bug
    // this replaces. Generous, because a first-run sign-in takes minutes.
    confirmWindow: num("HANDOFF_CONFIRM_WINDOW_MS", 120000),
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
function targetShows(call, paneId, markers) {
  let screen;
  try {
    screen = call(["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "400"]);
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed");
    return false;
  }
  const text = normalize(typeof screen === "string" ? screen : JSON.stringify(screen));
  return markers.some((marker) => text.includes(normalize(marker)));
}

// Delivery is confirmed by seeing the prompt on the target's own screen, and by
// nothing else.
//
// A state change looks tempting and is wrong: Antigravity churns through several
// states while it signs in, which is indistinguishable from reacting to a prompt
// it has not read yet. Measured live, that signal reported a delivered handoff
// while agy sat at an empty prompt.
async function confirmDelivery(call, paneId, markers, windowMs) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (targetShows(call, paneId, markers)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

function readScreen(call, paneId) {
  try {
    const out = call(["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "400"]);
    return normalize(typeof out === "string" ? out : JSON.stringify(out));
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed");
    return null;
  }
}

// Phrases an agent shows while it is starting up and discarding input. Waiting on
// "screen stopped changing" alone was far too slow: spinners, token counters and a
// blinking cursor mean many agents never hold a byte-identical screen, so every
// handoff sat out the whole cap — the minute-and-a-half that looked like a hang.
const NOT_READY = [
  "signing in", "sign in to", "logging in", "log in to", "authenticating",
  "authorizing", "waiting for browser", "opening browser", "initializing",
  "starting up", "loading model", "please wait",
];

function startingUp(screen) {
  if (!screen) return false;
  const lower = screen.toLowerCase();
  return NOT_READY.some((phrase) => lower.includes(phrase));
}

// Ready when the target is not visibly starting up and its screen has held still
// briefly. Fast agents clear this in well under a second; Antigravity is held back
// until its sign-in text disappears, which is the only reason it needed waiting for
// at all.
async function waitUntilReady(call, paneId, opts) {
  const { stillMs, graceMs, capMs, onSlow } = opts;
  const started = Date.now();
  const deadline = started + capMs;
  let last = readScreen(call, paneId);
  let since = Date.now();
  let warned = false;

  for (;;) {
    const busy = startingUp(last);
    const stable = Date.now() - since >= stillMs;
    // Once the startup text is gone, do not wait for a perfectly static screen
    // forever — a short grace period is enough.
    if (!busy && (stable || Date.now() - started >= graceMs)) {
      log(`target ready after ${Date.now() - started}ms`);
      return;
    }
    if (busy && !warned && Date.now() - started >= SLOW_NOTICE_MS) {
      warned = true;
      if (onSlow) onSlow();
    }
    if (Date.now() >= deadline) {
      log(`target still ${busy ? "starting up" : "unsettled"}; sending anyway`);
      return;
    }
    await sleep(400);
    const now = readScreen(call, paneId);
    if (now !== null && now !== last) {
      last = now;
      since = Date.now();
    }
  }
}

// A freshly launched agent reports itself ready while its TUI is still painting —
// and some, like Antigravity, sign in for a minute or two first. Text typed at a
// half-drawn input box is swallowed silently, which is why a handoff could report
// success over an empty prompt.
async function deliverPrompt(call, paneId, text, env, markers, onSlow) {
  const t = timings(env);
  await sleep(t.settle);
  await waitUntilReady(call, paneId, {
    stillMs: t.still,
    graceMs: t.grace,
    capMs: t.readyCap,
    onSlow,
  });

  // Submitted exactly once. Antigravity buffers text sent while it is finishing
  // sign-in and flushes the lot when it is ready: six retries put five copies of
  // the same handoff into it. Sending once and waiting is the only shape that
  // cannot hand the same task over repeatedly.
  try {
    call(["agent", "prompt", paneId, text]);
  } catch (err) {
    if (isMissing(err)) throw new TargetGone("target closed before the prompt was sent");
    throw err;
  }

  if (await confirmDelivery(call, paneId, markers, t.confirmWindow)) {
    log("prompt confirmed on the target's screen");
    return;
  }

  throw new Error(
    `the prompt never appeared in the target within ${Math.round(t.confirmWindow / 1000)}s`
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
      // A silent pane during a slow first-run sign-in reads as a failed handoff.
      () => notify(call, MESSAGES.startingUp(targetName)),
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

module.exports = { run, MESSAGES, shellIsAtPrompt, startingUp, NOT_READY };
