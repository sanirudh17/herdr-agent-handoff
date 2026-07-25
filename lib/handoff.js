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
async function waitForDetection(call, paneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (call(["pane", "get", paneId]).pane.agent) return true;
    } catch {
      // pane may briefly be unreadable while the agent takes over
    }
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function startAgent(call, { name, kind, paneId, command, env }) {
  if (!windowsAgentStartIsBroken(env)) {
    call([
      "agent", "start", name, "--kind", kind,
      "--pane", paneId, "--timeout", String(START_TIMEOUT_MS),
    ]);
    return;
  }

  call(["pane", "run", paneId, command]);
  if (!(await waitForDetection(call, paneId, START_TIMEOUT_MS))) {
    throw new Error(`${kind} was not detected in ${paneId}`);
  }
  call(["agent", "wait", paneId, "--until", "idle", "--timeout", String(START_TIMEOUT_MS)]);
  try {
    call(["agent", "rename", paneId, name]);
  } catch {
    // A missing name only costs a nicer sidebar label.
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
  } catch {
    const message = MESSAGES.startFailed(targetName);
    notify(call, message);
    return { ok: false, message };
  }

  // 8. Deliver the handoff. Addressed by pane id, which always identifies the
  //    agent; the name is only a sidebar label and may not have been applied.
  try {
    call(["agent", "prompt", targetPaneId, briefing.kickoff({ sourceName, handoffPath })]);
  } catch {
    const message = MESSAGES.promptFailed(targetName);
    notify(call, message);
    return { ok: false, message };
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

module.exports = { run, MESSAGES };
