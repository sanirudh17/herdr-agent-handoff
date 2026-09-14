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

// ---------------------------------------------------------------------------
// Local summarization (the default focused path).
//
// The source pane is never prompted: deriving the summary from the already
// resolved transcript keeps the live session untouched and lets the target
// pane be created immediately. Only short excerpts travel — never the full
// transcript body — and the target prompt still carries the safe transcript
// reference as an explicitly optional fallback.
// ---------------------------------------------------------------------------

const EXCERPT_CHARS = 500;
const FILES_MAX = 20;

function truncateText(text, max) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function textOf(value, depth = 0) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || depth > 3) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => textOf(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  const parts = [];
  for (const key of ["text", "content", "message", "input", "prompt"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      parts.push(value[key]);
    } else if (value[key] && typeof value[key] === "object") {
      const nested = textOf(value[key], depth + 1);
      if (nested) parts.push(nested);
    }
  }
  return parts.join("\n");
}

function roleOf(obj) {
  const raw =
    (obj && (obj.role || obj.author || obj.sender || obj.speaker)) || "";
  return String(raw).toLowerCase();
}

// Best-effort scan of a JSONL-ish transcript: first/last user excerpts plus the
// last assistant note. Unparseable lines are skipped; binary or foreign layouts
// simply yield fewer excerpts rather than an error.
function collectExcerpts(session) {
  const found = { firstUser: "", lastUser: "", lastAssistant: "" };
  let body;
  try {
    body = session.body.toString("utf8");
  } catch {
    return found;
  }
  const lines = body.split("\n");
  // Bound the scan: the head holds the objective, the tail the latest state.
  const picked =
    lines.length <= 500
      ? lines
      : [...lines.slice(0, 400), ...lines.slice(-100)];
  for (const line of picked) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const role = roleOf(obj);
    const text = textOf(obj).trim();
    if (!text) continue;
    if (/user|human|customer/.test(role)) {
      if (!found.firstUser) found.firstUser = text;
      found.lastUser = text;
    } else if (/assistant|agent|model|ai|bot/.test(role)) {
      found.lastAssistant = text;
    }
  }
  return found;
}

function extractFiles(text) {
  const seen = [];
  const push = (file) => {
    const clean = String(file || "")
      .replace(/[\s"'`,;]+$/g, "")
      .slice(0, 120);
    if (clean.length < 3 || seen.includes(clean)) return;
    if (seen.length < FILES_MAX) seen.push(clean);
  };
  const patterns = [
    /[A-Za-z]:\\[^\s"'`,;]+/g,
    /(?:~?\/(?:\.?\.?\/)*[\w.+~=-][\w.+~/=-]*)/g,
    /[\w.=-]+\/[\w.+/=-]{2,}/g,
  ];
  for (const pattern of patterns) {
    const matches = String(text || "").match(pattern) || [];
    for (const match of matches) {
      if (/^https?:\/\//i.test(match)) continue;
      push(match);
    }
    if (seen.length >= FILES_MAX) break;
  }
  return seen;
}

function summarizeSession({ meta = {}, session } = {}) {
  if (!session || !session.body || session.body.length === 0) {
    throw new Error("there is no resolved session to summarize");
  }
  const excerpts = collectExcerpts(session);
  const files = extractFiles(
    [excerpts.firstUser, excerpts.lastUser, excerpts.lastAssistant]
      .filter(Boolean)
      .join("\n"),
  );
  const lines =
    typeof session.lines === "number"
      ? session.lines.toLocaleString("en-US")
      : "?";
  const bytes =
    typeof session.bytes === "number"
      ? session.bytes.toLocaleString("en-US")
      : "?";
  const objective = excerpts.firstUser
    ? truncateText(excerpts.firstUser, EXCERPT_CHARS)
    : "Not identified from the transcript scan — inspect the workspace and the fallback reference.";
  const latest = excerpts.lastUser
    ? truncateText(excerpts.lastUser, EXCERPT_CHARS)
    : "No later user request identified.";
  const note = excerpts.lastAssistant
    ? truncateText(excerpts.lastAssistant, 300)
    : "No assistant note identified.";
  const fileLines =
    files.length > 0
      ? files.map((file) => `- \`${file}\``).join("\n")
      : "- None identified from the transcript scan.";
  return [
    "# Focused Handoff",
    "",
    "(Derived from the resolved transcript without prompting the source pane; the workspace is authoritative.)",
    "",
    "## Current objective",
    `- ${objective}`,
    "",
    "## Completed work",
    `- Source session holds ${lines} lines (${bytes} bytes, \`${session.strategy || "unknown"}\` store). Last assistant note: ${note}`,
    "",
    "## Current state",
    `- Workspace \`${meta.cwd || ""}\` is authoritative; captured at ${meta.snapshotUtc || "unknown"}. Latest user request: ${latest}`,
    "",
    "## Remaining work",
    "- Continue from the workspace state. Consult the fallback transcript only for a specific missing fact.",
    "",
    "## Important constraints / user preferences",
    "- Preserve uncommitted work; never revert, reset, stash, discard, or clean anything not created by the target.",
    "",
    "## Pitfalls / do not redo",
    "- Older diagnostic steps in the transcript history are historical and must not be replayed.",
    "",
    "## Relevant files",
    fileLines,
    "",
  ].join("\n");
}

// File-first capture via the live source agent.
//
// LEGACY / opt-in only: prompting the source pane interrupts the user's active
// session and blocks target creation until the agent writes the file, which is
// why focused handoffs appeared to "land in the same agent". The default
// focused path uses summarizeSession instead and never touches the source
// pane. Kept exported for tests and for explicit dependency injection.
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
  summarizeSession,
  focusedDir,
  newOutputPath,
  focusedTimeoutMs,
  validateSummary,
};
