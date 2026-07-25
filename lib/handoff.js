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
// Delivery timings. Overridable so the tests do not have to sit through a
// minute of real backoff to exercise the retry path.
//
// Four spaced attempts cover an agent that spends a minute or two signing in on
// first run. A retry is only ever reached when the agent showed no reaction at
// all, so the text did not land and cannot be duplicated by trying again.
function timings(env) {
  const num = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const backoff = env.HANDOFF_RETRY_BACKOFF_MS
    ? env.HANDOFF_RETRY_BACKOFF_MS.split(",").map((n) => Number(n) || 0)
    : [4000, 10000, 20000];
  return {
    // Let a freshly started agent finish drawing its input box before typing at it.
    settle: num("HANDOFF_SETTLE_MS", 1200),
    deliveryTimeout: num("HANDOFF_DELIVERY_TIMEOUT_MS", 20000),
    confirmWindow: num("HANDOFF_CONFIRM_WINDOW_MS", 4000),
    attempts: num("HANDOFF_DELIVERY_ATTEMPTS", 4),
    backoff,
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

function reacted(before, now) {
  if (!now) return false;
  if (!before) return now.status !== "idle";
  return now.seq > before.seq || (now.status !== "idle" && now.status !== before.status);
}

async function confirmReaction(call, paneId, before, windowMs) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const now = agentSnapshot(call, paneId);
    if (reacted(before, now)) return now;
    if (Date.now() >= deadline) return null;
    await sleep(300);
  }
}

// A freshly launched agent reports itself ready while its TUI is still painting —
// and some, like Antigravity, sign in for a minute or two first. Text typed at a
// half-drawn input box is swallowed silently, which is why a handoff could report
// success over an empty prompt.
//
// So: submit, then prove the agent reacted. Retry only when nothing at all
// happened, since that is the only case where the text certainly did not land.
async function deliverPrompt(call, paneId, text, env) {
  const t = timings(env);
  await sleep(t.settle);

  for (let attempt = 1; attempt <= t.attempts; attempt += 1) {
    const before = agentSnapshot(call, paneId);
    let waitError = null;
    try {
      call(["agent", "prompt", paneId, text, "--wait", "--until", "working",
        "--timeout", String(t.deliveryTimeout)]);
    } catch (err) {
      waitError = err;
    }

    if (!waitError) {
      log(`prompt delivered; target is working (attempt ${attempt})`);
      return;
    }

    // The wait complained. Ask the agent itself whether it reacted.
    const after = await confirmReaction(call, paneId, before, t.confirmWindow);
    if (after) {
      log(
        `submission wait reported "${waitError.code || "failure"}" but the agent reacted ` +
        `(status ${after.status}); treating as delivered`
      );
      return;
    }

    log(
      `no reaction after attempt ${attempt} (wait said "${waitError.code || "failure"}"); ` +
      (attempt < t.attempts ? "the agent was not ready — retrying" : "giving up")
    );
    if (attempt >= t.attempts) throw waitError;
    await sleep(t.backoff[attempt - 1] || 5000);
  }
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
  try {
    await deliverPrompt(call, targetPaneId, briefing.kickoff({ sourceName, handoffPath }), env);
  } catch (err) {
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

module.exports = { run, MESSAGES, shellIsAtPrompt };
