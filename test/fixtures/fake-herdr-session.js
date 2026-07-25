#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const argv = process.argv.slice(2);
const callsFile = process.env.HANDOFF_FAKE_CALLS;
if (callsFile) fs.appendFileSync(callsFile, JSON.stringify(argv) + "\n");

const joined = argv.join(" ");
const fail = process.env.HANDOFF_FAKE_FAIL;
if (fail && joined.startsWith(fail)) {
  const code = process.env.HANDOFF_FAKE_ERROR_CODE || "boom";
  // Fail only for as many attempts as asked, so a retry can succeed.
  const limit = Number(process.env.HANDOFF_FAKE_FAIL_TIMES || "0");
  const countFile = process.env.HANDOFF_FAKE_COUNT;
  let attempts = 0;
  if (limit > 0 && countFile) {
    try {
      attempts = Number(fs.readFileSync(countFile, "utf8")) || 0;
    } catch {
      attempts = 0;
    }
    fs.writeFileSync(countFile, String(attempts + 1));
  }
  if (limit === 0 || attempts < limit) {
    process.stdout.write(
      JSON.stringify({ error: { code, message: `${fail} failed` }, id: "cli:x" }) + "\n"
    );
    process.exit(1);
  }
}

function ok(result) {
  process.stdout.write(JSON.stringify({ id: "cli:x", result }) + "\n");
  process.exit(0);
}

const agent = process.env.HANDOFF_FAKE_AGENT || "";
const session = JSON.parse(process.env.HANDOFF_FAKE_SESSION || "null");

if (argv[0] === "pane" && argv[1] === "get") {
  ok({
    type: "pane_info",
    pane: {
      pane_id: "w5:p1", terminal_id: "t1", workspace_id: "w5", tab_id: "w5:t1",
      focused: true, agent_status: "idle", revision: 1,
      agent: agent || null,
      cwd: process.env.HANDOFF_TEST_HOME || process.cwd(),
      agent_session: session
        ? { agent, kind: session.kind, source: `herdr:${agent}`, value: session.value }
        : null,
    },
  });
}

if (argv[0] === "pane" && argv[1] === "split") {
  ok({
    type: "pane_info",
    pane: {
      pane_id: "w5:p2", terminal_id: "t2", workspace_id: "w5", tab_id: "w5:t1",
      focused: false, agent_status: "unknown", revision: 1,
    },
  });
}

if (argv[0] === "tab" && argv[1] === "create") {
  ok({
    type: "tab_info",
    tab: {
      tab_id: "w5:t2", workspace_id: "w5", number: 2, label: "handoff",
      focused: false, pane_count: 1, agent_status: "unknown",
    },
  });
}

if (argv[0] === "pane" && argv[1] === "list") {
  ok({
    type: "pane_list",
    panes: [
      { pane_id: "w5:p1", terminal_id: "t1", workspace_id: "w5", tab_id: "w5:t1", focused: true, agent_status: "idle", revision: 1 },
      { pane_id: "w5:p9", terminal_id: "t9", workspace_id: "w5", tab_id: "w5:t2", focused: false, agent_status: "unknown", revision: 1 },
    ],
  });
}

if (argv[0] === "agent" && argv[1] === "start") {
  ok({
    type: "agent_started",
    argv: ["claude"],
    agent: {
      terminal_id: "t2", agent_status: "idle", workspace_id: "w5", tab_id: "w5:t1",
      pane_id: "w5:p2", focused: false, revision: 1, name: argv[2],
    },
  });
}

// A shell sitting at its prompt still reports itself as the foreground process
// on Windows, with pid == shell_pid. Reproducing that here rather than an empty
// list keeps the readiness check honest.
if (argv[0] === "pane" && argv[1] === "process-info") {
  ok({
    type: "pane_process_info",
    process_info: {
      pane_id: argv[3],
      shell_pid: 4242,
      foreground_process_group_id: 4242,
      foreground_processes: [{ pid: 4242, name: "powershell.exe" }],
    },
  });
}

// `herdr pane run` goes through send_ok_request: exit 0 and NOT a byte of
// stdout. Anything expecting a JSON envelope from it breaks.
if (argv[0] === "pane" && argv[1] === "run") process.exit(0);
if (argv[0] === "agent" && argv[1] === "wait") ok({ type: "agent_info", agent: { agent_status: "idle" } });
if (argv[0] === "agent" && argv[1] === "rename") ok({ type: "agent_info", agent: { name: argv[3] } });

if (argv[0] === "agent" && argv[1] === "prompt") ok({ type: "agent_prompted" });

if (argv[0] === "agent" && argv[1] === "focus") {
  ok({
    type: "agent_info",
    agent: {
      terminal_id: "t2", agent_status: "idle", workspace_id: "w5", tab_id: "w5:t1",
      pane_id: "w5:p2", focused: true, revision: 1,
    },
  });
}

if (argv[0] === "notification") ok({ type: "notification_shown" });

if (argv[0] === "plugin") {
  ok({ type: "plugin_pane_opened", plugin_pane: { plugin_id: "agent-handoff", entrypoint_id: "picker" } });
}

ok({ type: "unknown" });
