"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const paths = require("./paths.js");
const { SENTINEL } = require("./briefing.js");

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

// ---------------------------------------------------------------------------
// Transcript scanning across every supported source agent.
//
// Each agent nests roles and prose differently — top-level {role, content}
// (pi and forks), {type, message: {role, content}} with content blocks
// (Claude Code), {type: response_item, payload: {role, content}} with
// input/output_text blocks (Codex), whole-file [{role, content}] arrays
// (cline), {table, row} SQLite-export envelopes with the payload in
// row.data (opencode), and free-form JSONL for the rest. Rather than a
// per-kind switch that rots with every new agent, the scan is shape-driven:
// it recognises role and prose shapes wherever they nest, and skips
// everything else (tool calls/results, encrypted blobs, session metadata).
// Unknown layouts degrade to fewer excerpts, never to an error.
// ---------------------------------------------------------------------------

const ROLE_KEYS = ["role", "author", "sender", "speaker"];
const NEST_KEYS = ["message", "payload", "data"];
// Object keys that may carry prose, descended into recursively.
const PROSE_KEYS = [
  "text",
  "content",
  "message",
  "payload",
  "data",
  "input",
  "output",
  "prompt",
  "body",
];
// Content-block types that carry prose. Tool calls, tool results, thinking
// and encrypted blocks are deliberately excluded: they are megabyte-scale
// noise, never the objective.
const PROSE_BLOCKS = new Set(["text", "input_text", "output_text"]);
// Lines longer than this are tool-result dumps, not conversation.
const MAX_LINE_CHARS = 200000;
// Whole-file JSON above this falls back to a line scan.
const MAX_ARRAY_BYTES = 20 * 1024 * 1024;

function shortRole(value) {
  if (typeof value !== "string") return "";
  const clean = value.trim().toLowerCase();
  return clean.length > 0 && clean.length < 40 ? clean : "";
}

// Finds the speaker of one transcript entry, however the agent nests it.
function findRole(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  for (const key of ROLE_KEYS) {
    const role = shortRole(entry[key]);
    if (role) return role;
  }
  for (const key of NEST_KEYS) {
    const nested = entry[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const rk of ROLE_KEYS) {
        const role = shortRole(nested[rk]);
        if (role) return role;
      }
    }
  }
  if (entry.type === "user" || entry.type === "assistant") return entry.type;
  return "";
}

function collectStrings(value, out, depth) {
  if (out.chars > 4000 || depth > 4 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    out.parts.push(value);
    out.chars += value.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.type === "string" &&
        !PROSE_BLOCKS.has(item.type)
      ) {
        continue;
      }
      collectStrings(item, out, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const key of PROSE_KEYS) {
      if (key in value) collectStrings(value[key], out, depth + 1);
    }
  }
}

// The prose carried by one entry: content blocks, nested message/payload
// text, plain string fields. Tool-call shapes contribute nothing.
function entryText(entry) {
  const out = { parts: [], chars: 0 };
  collectStrings(entry, out, 0);
  return out.parts
    .map((part) => String(part).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function isUserRole(role) {
  return /\b(user|human|customer)\b/.test(role);
}

function isAssistantRole(role) {
  return /\b(assistant|agent|ai|bot|model)\b/.test(role);
}

// Bare continuations and acknowledgments ("Please continue", "thanks!") carry
// no objective. They still count as activity, but the summary slots prefer the
// nearest substantive message so the objective is never "Please continue".
const VACUOUS_USER =
  /^(please |pls )?(continue|go on|go ahead|go|proceed|do it|retry( again)?|same( again| error)?|ok|okay|k|sure|yes|yeah|yep|yup|y|no|nope|n|thanks|thank you|thx|ty|sounds good|great|perfect|nice|awesome|cool|lgtm|looks good|fine|alright|right|hmm+|uh|er+)[\s.!?…]*$/i;

function isSubstantiveUser(text) {
  return !VACUOUS_USER.test(
    String(text || "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// A transcript often embeds older handoffs of its own: a previous handoff
// prompt travels as a user message in the next session, chains nest further,
// and the export paths, hashes and boilerplate inside them are history, not
// the current objective. Any span from a handoff opening to its sentinel is
// cut from excerpt candidacy. The inner focused summary of the most recent
// embedded handoff is kept: for a chained session it is the best available
// statement of what came before.
const HANDOFF_OPEN = "You are taking over this ";

function extractInnerSummary(block) {
  const match = block.match(
    /## Focused handoff summary\s+([\s\S]*?)\s*## How to continue/,
  );
  const inner = match ? match[1].trim() : "";
  return inner.length > 0 ? inner.slice(0, 2000) : "";
}

function splitHandoffs(text) {
  let clean = String(text || "");
  const innerSummaries = [];
  for (;;) {
    const start = clean.indexOf(HANDOFF_OPEN);
    if (start === -1) break;
    const end = clean.indexOf(SENTINEL, start);
    if (end === -1) break;
    const block = clean.slice(start, end + SENTINEL.length);
    const inner = extractInnerSummary(block);
    if (inner) innerSummaries.push(inner);
    clean = `${clean.slice(0, start)} ${clean.slice(end + SENTINEL.length)}`;
  }
  return { clean: clean.replace(/\s+/g, " ").trim(), innerSummaries };
}

// opencode's SQLite export wraps every row as {table, row}, with the original
// payload in row.data. Message rows precede part rows, so a single pass can
// attribute parts to their message's role via the message id.
function unwrapExportRow(obj, rolesByMessage) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const row = obj.row && typeof obj.row === "object" ? obj.row : null;
  const table = typeof obj.table === "string" ? obj.table : "";
  const entry =
    row && row.data && typeof row.data === "object" ? row.data : row || obj;
  if (table === "message") {
    const role = findRole(entry) || findRole(row);
    const id = (row && (row.id || row.ID)) || entry.id;
    if (role && id !== undefined) rolesByMessage.set(String(id), role);
  }
  let role = findRole(entry);
  if (!role && row) {
    const mid = row.message_id ?? row.messageID ?? row.messageId;
    if (mid !== undefined && mid !== null) {
      role = rolesByMessage.get(String(mid)) || "";
    }
    // opencode text parts carry the prose; tool parts contribute nothing.
    if (!role && typeof row.type === "string" && row.type === "text") {
      role = "assistant";
    }
  }
  return { role, entry };
}

function harvestFallback(obj, fallback) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  // Claude Code's running summary of the session so far.
  if (
    obj.type === "summary" &&
    typeof obj.summary === "string" &&
    obj.summary.trim()
  ) {
    if (!fallback.summary) fallback.summary = obj.summary;
  }
  // opencode's session row carries the session title.
  if (obj.table === "session") {
    const row = obj.row && typeof obj.row === "object" ? obj.row : {};
    const data = row.data && typeof row.data === "object" ? row.data : {};
    const title = row.title || data.title;
    if (typeof title === "string" && title.trim() && !fallback.title) {
      fallback.title = title;
    }
  }
}

// Best-effort scan of a transcript body: first/last user excerpts plus the
// last assistant note, in transcript order. Whole-file JSON arrays (cline's
// messages file) are read as entries; otherwise the body is scanned line by
// line, parsing only lines that advertise role-bearing shapes so multi-megabyte
// tool dumps are skipped without a parse.
function collectExcerpts(session) {
  const found = {
    firstUser: "",
    lastUser: "",
    lastAssistant: "",
    firstSubstantive: "",
    lastSubstantive: "",
  };
  const fallback = {};
  let body;
  try {
    body = session.body.toString("utf8");
  } catch {
    return found;
  }
  const trimmed = body.trim();
  if (
    (trimmed.startsWith("[") || trimmed.startsWith('{"messages"')) &&
    Buffer.byteLength(trimmed, "utf8") <= MAX_ARRAY_BYTES
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.messages)
          ? parsed.messages
          : null;
      if (entries) {
        for (const entry of entries)
          noteEntry(entry, found, fallback, new Map());
        return finishExcerpts(found, fallback);
      }
    } catch {
      // fall through to the line scan
    }
  }
  const rolesByMessage = new Map();
  for (const line of body.split("\n")) {
    if (!line || line.length > MAX_LINE_CHARS) continue;
    if (
      !/"(role|sender|author|speaker|summary|title)"|"type":"(user|assistant)"|"table":"/.test(
        line,
      )
    ) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    noteEntry(obj, found, fallback, rolesByMessage);
  }
  return finishExcerpts(found, fallback);
}

function noteEntry(obj, found, fallback, rolesByMessage) {
  if (!obj || typeof obj !== "object") return;
  harvestFallback(obj, fallback);
  const unwrapped = unwrapExportRow(obj, rolesByMessage);
  const role = unwrapped ? unwrapped.role : findRole(obj);
  const raw = (unwrapped ? entryText(unwrapped.entry) : entryText(obj)).trim();
  if (!raw) return;
  // Embedded older handoffs are history, not candidacy — except that the most
  // recent one's inner summary is the best fallback for chained sessions.
  const { clean: text, innerSummaries } = splitHandoffs(raw);
  for (const inner of innerSummaries) fallback.inner = inner;
  if (!text) return;
  if (isUserRole(role)) {
    if (!found.firstUser) found.firstUser = text;
    found.lastUser = text;
    if (isSubstantiveUser(text)) {
      if (!found.firstSubstantive) found.firstSubstantive = text;
      found.lastSubstantive = text;
    }
  } else if (isAssistantRole(role)) {
    found.lastAssistant = text;
  }
}

function finishExcerpts(found, fallback) {
  found.firstUser = String(
    found.firstSubstantive ||
      found.firstUser ||
      fallback.inner ||
      fallback.summary ||
      fallback.title ||
      "",
  );
  found.lastUser = String(found.lastSubstantive || found.lastUser || "");
  return found;
}

function extractFiles(text) {
  const seen = [];
  const push = (file) => {
    let clean = String(file || "")
      .replace(/[\s"'`,;]+$/g, "")
      .slice(0, 120);
    // A path followed by prose ("shot.png Okay, see…"): cut at the first
    // space that follows a file extension. Extensionless directories
    // ("Herdr plugin") never match, so they survive whole.
    const cut = clean.search(/(?<=\.[A-Za-z0-9]{1,8}) +(?=[A-Za-z])/);
    if (cut !== -1) clean = clean.slice(0, cut);
    if (clean.length < 3 || seen.includes(clean)) return;
    if (seen.length < FILES_MAX) seen.push(clean);
  };
  const patterns = [
    // Windows paths contain spaces far too often (Claude Code, Herdr plugin)
    // to stop at whitespace; trailing junk is trimmed in push().
    /[A-Za-z]:\\[^\n"'`,;]+/g,
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
