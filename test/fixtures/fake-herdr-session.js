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
    // stderr, as Herdr does.
    process.stderr.write(
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

// The agent record the delivery check reads. HANDOFF_FAKE_REACTS decides whether
// the agent appears to react to a prompt: "never" models an agent whose TUI
// swallows input while it is still starting up.
// Two independent knobs, because delivery has two independent proofs:
//   HANDOFF_FAKE_REACTS=never  -> the screen never echoes the prompt
//   HANDOFF_FAKE_NO_SEQ=1      -> the agent never changes state either
if (argv[0] === "agent" && argv[1] === "get") {
  const stirs = process.env.HANDOFF_FAKE_NO_SEQ !== "1";
  const countFile = process.env.HANDOFF_FAKE_GET_COUNT;
  let seq = 0;
  if (stirs && countFile) {
    try {
      seq = Number(fs.readFileSync(countFile, "utf8")) || 0;
    } catch {
      seq = 0;
    }
    fs.writeFileSync(countFile, String(seq + 1));
  }
  ok({
    type: "agent_info",
    agent: {
      terminal_id: "t2", workspace_id: "w5", tab_id: "w5:t1", pane_id: argv[2],
      focused: false, revision: 1, agent: agent || "claude",
      // HANDOFF_FAKE_STATUS pins the reported state, e.g. "blocked" for an agent
      // sitting on a permission or trust prompt.
      agent_status: process.env.HANDOFF_FAKE_STATUS || (stirs && seq > 0 ? "working" : "idle"),
      state_change_seq: seq,
    },
  });
}

// The target's screen. A healthy agent echoes the prompt it was given, so the
// recorded calls are the source of truth: if a prompt was submitted, it shows.
// HANDOFF_FAKE_REACTS=never models a TUI that swallows input while still starting.
if (argv[0] === "agent" && argv[1] === "read") {
  let text = "";
  // HANDOFF_FAKE_SWALLOW_FIRST=n discards the first n submissions, modelling an
  // agent whose input box is not listening yet.
  const swallow = Number(process.env.HANDOFF_FAKE_SWALLOW_FIRST || "0");
  if (process.env.HANDOFF_FAKE_REACTS !== "never" && callsFile) {
    try {
      let prompts = 0;
      for (const line of fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean)) {
        const call = JSON.parse(line);
        if (call[0] === "agent" && call[1] === "prompt" && call[2] === argv[2]) {
          prompts += 1;
          if (prompts > swallow) text = call[3];
        }
      }
    } catch {
      text = "";
    }
  }
  // `herdr agent read` prints the screen as PLAIN TEXT — no JSON envelope. A
  // fixture that answered with JSON is exactly why the broken read passed every
  // test while never once working against the real CLI.
  // HANDOFF_FAKE_SCREEN prepends fixed screen content, e.g. a trust dialog.
  process.stdout.write((process.env.HANDOFF_FAKE_SCREEN || "") + " " + text + "\n");
  process.exit(0);
}

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
