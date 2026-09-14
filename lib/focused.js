"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const paths = require("./paths.js");

function focusedDir(env = process.env) {
  return path.join(paths.stateDir(env), "focused-handoffs");
}

function newOutputPath(env = process.env) {
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(9).toString("base64url");
  return path.join(focusedDir(env), `${Date.now()}-${id}.md`);
}

function focusedTimeoutMs(env = process.env) {
  const value = Number(env.HANDOFF_FOCUSED_TIMEOUT_MS);
  if (Number.isFinite(value) && value >= 0) return value;
  return 120000;
}

function focusedPollMs(env = process.env) {
  const value = Number(env.HANDOFF_FOCUSED_POLL_MS);
  if (Number.isFinite(value) && value > 0) return value;
  return 500;
}

// The request sent to the SOURCE agent. Strict on purpose: the source owns the
// current context, so it writes the summary itself instead of dumping the whole
// transcript into the target.
function buildSummaryRequest({ meta, outputPath }) {
  return `You are preparing a focused handoff for another agent.

Do not modify files, except to write the handoff file described below.
Do not run commands unless absolutely required to verify current state.
Do not continue implementation.
Your only task is to summarize the current state for a fresh agent.

Produce a concise handoff with these sections:

# Focused Handoff

## Current objective
- What the user ultimately wants.

## Completed work
- What has already been implemented, changed, diagnosed, or decided.
- Include file paths and important commands/tests.

## Current state
- What the workspace/session state is now.
- Mention whether the task appears complete or incomplete.

## Remaining work
- Exact next steps, if any.
- If nothing remains, say clearly: "No remaining work identified."

## Important constraints / user preferences
- Include only constraints that matter going forward.

## Pitfalls / do not redo
- Mention old diagnoses, failed approaches, or solved problems that the next agent must NOT repeat.

## Relevant files
- List paths with one-line purpose.

Keep this focused. Exclude conversational back-and-forth, dead ends that no longer matter, and historical handoff chains unless they affect the current state.

Write exactly that markdown handoff to this file and nothing else:

\`${outputPath}\`

Source session: \`${meta.sessionId || ""}\`
Working directory: \`${meta.cwd || ""}\`
`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validateSummary(text) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("the source agent produced an empty summary");
  return clean;
}

// File-first capture: the source agent writes the summary to a temp file under
// the plugin state dir (outside the user's repo), and the plugin reads it back.
// Throws on timeout or empty output; the caller must not create the target.
async function generateFocusedSummary({
  call,
  sourcePaneId,
  meta,
  env = process.env,
  outputPath,
  timeoutMs,
  pollMs,
} = {}) {
  if (!call) throw new Error("no Herdr caller available");
  if (!sourcePaneId) throw new Error("no source pane to summarize from");
  const out = outputPath || newOutputPath(env);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const request = buildSummaryRequest({ meta: meta || {}, outputPath: out });
  call(["agent", "prompt", sourcePaneId, request]);
  const deadline = Date.now() + (timeoutMs ?? focusedTimeoutMs(env));
  const interval = pollMs ?? focusedPollMs(env);
  for (;;) {
    try {
      if (fs.existsSync(out)) {
        const body = fs.readFileSync(out, "utf8").trim();
        if (body) return validateSummary(body);
      }
    } catch {
      // still being written; keep waiting
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the source agent did not write a focused summary to ${out} in time`,
      );
    }
    await sleep(interval);
  }
}

module.exports = {
  buildSummaryRequest,
  generateFocusedSummary,
  focusedDir,
  newOutputPath,
  focusedTimeoutMs,
  validateSummary,
};
