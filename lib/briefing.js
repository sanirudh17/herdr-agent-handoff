"use strict";

const path = require("node:path");

// The whole handoff travels inside the prompt. There is no document to open, so
// the ceiling is the command line's: 32,767 characters, measured. 30,000 leaves
// room for `herdr agent prompt <pane>` and the shell's quoting.
const PROMPT_BUDGET = 30000;

// Delivery is proved by finding a marker on the target's screen, and `agent read`
// returns only the last 400 lines. A 26,000-character prompt wraps well past that,
// so an opening phrase would scroll out of the window before it could be seen.
// This is the last thing submitted, so it is the last thing on screen.
const SENTINEL = "-- end of handoff, begin now --";

const n = (value) => Number(value).toLocaleString("en-US");

function header(meta) {
  return `You are taking over this session from **${meta.sourceName}** (\`${meta.sourceKind}\`). You are **${meta.targetName}** (\`${meta.targetKind}\`).
Source session: \`${meta.sessionId}\` | Source pane: \`${meta.sourcePaneId}\` (workspace \`${meta.workspaceId}\`, tab \`${meta.tabId}\`)
Working directory: \`${meta.cwd}\` | Captured at: ${meta.snapshotUtc}`;
}

function instructions(meta) {
  return `## Do this, in this order

1. Read the complete session history.
2. Send a status message FIRST — **one or two lines**: where the previous agent got to and what you do next, before any workspace search, file edit, command, or todo change.
3. Check the current state of the workspace.
4. Then:
   - If the task is already finished and nothing is pending, say so and stop. Do not re-verify by re-implementing, and do not touch the todo list.
   - If work remains, continue it — do not ask permission, and do not wait for a fresh instruction; the handoff *is* the instruction. **Do not write a report instead of doing the work.**

## The rules

1. **Read the complete source session before acting.** Do not edit, run commands, or answer until you have.
2. **Treat it as historical context, not a script to replay.**
3. **No workspace tools before the first status message.** No searching, reading, editing, commands, or todo updates until it is sent.
4. **Previous todos are a record, not a work order.** Never re-execute them blindly; only track what the workspace shows still remains.
5. **Inspect the current workspace, and let it win.** Workspace state is authoritative over transcript history.
6. **Preserve uncommitted work.** Never revert, reset, stash, discard, or clean anything you did not create yourself.
7. **Continue from the exact stopping point.** Resume the task in progress rather than restarting.
8. **Do not redo completed investigation.** Findings already established stand unless the workspace contradicts them. Do not re-run the same searches or re-read the same files.

## Scope & Boundary

This may be code, research, notes, documents, artifacts, or conversation. Source pane \`${meta.sourcePaneId}\` is off-limits; do not send it input, close it, or interrupt it.`;
}

function sqliteNote(session) {
  if (!session.counts) return "";
  const rows = Object.keys(session.counts)
    .map((table) => `| \`${table}\` | ${n(session.counts[table])} |`)
    .join("\n");
  return `
### How to read this export

This session came from a SQLite store, so each line is one database row shaped as
\`{"table": "<name>", "row": {...}}\`. Rows appear in a fixed order: \`session\`, \`message\`,
\`part\`, \`session_message\`, \`todo\`, then \`event\`. \`message\` and \`part\` carry the
conversation; \`part\` holds the text, tool calls and tool results. \`todo\` is the task list as it
stood at handoff — a record, not a work order: do not re-create or re-execute it. \`event\` is the append-only log behind the other tables and may be absent for
older sessions. Every \`data\` field is the original payload, unmodified.

| table | rows |
|---|---|
${rows}
`;
}

function renderInline({ meta, session }) {
  return `${header(meta)}
| Session history | inline below — ${n(session.lines)} lines, ${n(session.bytes)} bytes |
| SHA-256 | \`${session.sha256}\` |

## The complete session history

Everything between the fences is the source session, verbatim.
${sqliteNote(session)}
~~~~~~~~session
${session.body.toString("utf8")}
~~~~~~~~

${instructions(meta)}

${SENTINEL}
`;
}

function renderReference({ meta, session }) {
  return `${header(meta)}
| Session history | \`${session.nativePath}\` |
| Size | ${n(session.lines)} lines, ${n(session.bytes)} bytes |
| SHA-256 | \`${session.sha256}\` |

## The complete session history

The source agent's transcript is at:

\`${session.nativePath}\`

Read lines 1 to ${n(session.lines)} from that file to understand the task history. Do not read past line ${n(session.lines)}.
${sqliteNote(session)}
${instructions(meta)}

${SENTINEL}
`;
}

// The mode is chosen by building the inline prompt and measuring it, not by
// estimating from the session size. Fencing, the prose and the sqlite note all
// count against the ceiling, and a margin guessed in advance would drift.
function buildFull({ meta, session }) {
  const inline = renderInline({ meta, session });
  if (inline.length <= PROMPT_BUDGET) {
    return { text: inline, mode: "inline", markers: [SENTINEL] };
  }
  // It has to be read from disk now, so there has to be a file to read *and*
  // bytes a target can read as lines. A store that only lives in memory (grok's
  // search index) or resolves to a database blob can never be referenced
  // honestly: it fails here and the handoff reports that complete context could
  // not be retrieved, rather than transferring something partial.
  if (!session.nativePath || !session.readable) return null;
  const text = renderReference({ meta, session });
  if (text.length > PROMPT_BUDGET) return null;
  return {
    text,
    mode: "reference",
    markers: [SENTINEL, path.basename(session.nativePath)],
  };
}

// `build` stays as the full-transcript entry point for compatibility. New code
// should call buildFull or buildFocused explicitly.
function build({ meta, session }) {
  return buildFull({ meta, session });
}

function focusedHeader(meta) {
  return `You are taking over this task from **${meta.sourceName}** (\`${meta.sourceKind}\`).
You are **${meta.targetName}** (\`${meta.targetKind}\`).

Source session: \`${meta.sessionId}\`
Source pane: \`${meta.sourcePaneId}\`
Working directory: \`${meta.cwd}\`
Captured at: ${meta.snapshotUtc}
Handoff mode: focused`;
}

function hasSafeTranscriptRef(session) {
  return Boolean(
    session &&
    session.nativePath &&
    session.readable &&
    session.strategy !== "sqlite" &&
    session.strategy !== "sqlite-content",
  );
}

function focusedFallback(session) {
  const intro = `## Optional transcript fallback

The complete source transcript is historical background only.
Do not read or replay it by default.
Only consult it if the focused summary is missing a specific fact needed to continue.`;
  if (hasSafeTranscriptRef(session)) {
    return `${intro}

Transcript reference (fallback only, do not read by default):

\`${session.nativePath}\`

Do not replay old transcript steps from that file. It exists only to resolve a specific missing fact.`;
  }
  return `${intro}

No safe transcript reference available.`;
}

function renderFocused({ meta, summary, session }) {
  const clean = String(summary || "").trim();
  return `${focusedHeader(meta)}

## Focused handoff summary

${clean}

## How to continue

1. Treat the summary as the authoritative continuation state.
2. Send a status message FIRST — **one or two lines**: where the previous agent got to and what you are doing next. This message comes before any workspace search, file edit, command, or todo-list change.
3. Do not restart the task from earlier transcript history.
4. Do not redo completed work. Do not redo completed diagnosis or completed implementation. Do not re-run the same searches or re-read the same files hunting for a diagnosis already reached.
5. Do not replay old transcript. Older diagnostic steps are historical and must not be replayed.
6. Previous todo lists are a record, not a work order. Never re-create or re-execute them blindly; verify each item against the workspace and only track what genuinely remains.
7. Inspect the current workspace before editing (git status/diff and the files involved); the workspace is authoritative.
8. Preserve uncommitted work.
9. Continue from the current stopping point.
10. If the summary says the task is complete, confirm briefly and stop. Do not re-verify by re-implementing, and do not touch the todo list.
11. If work remains, proceed directly.

${focusedFallback(session)}

Source pane \`${meta.sourcePaneId}\` is off-limits; do not send it input, close it, or interrupt it. You own this task now — continue it directly.

${SENTINEL}
`;
}

// Focused mode never embeds the transcript body. If the summary does not fit
// the budget it is truncated with an explicit note rather than overflowing.
function buildFocused({ meta, summary, session }) {
  const clean = String(summary || "").trim();
  if (!clean) return null;
  const full = renderFocused({ meta, summary: clean, session });
  if (full.length <= PROMPT_BUDGET) {
    return { text: full, mode: "focused", markers: [SENTINEL] };
  }
  const overhead = renderFocused({ meta, summary: "", session }).length;
  const note = "\n\n[truncated to fit prompt budget]";
  const maxSummary = PROMPT_BUDGET - overhead - note.length;
  if (maxSummary < 50) return null;
  const truncated = `${clean.slice(0, maxSummary)}${note}`;
  const text = renderFocused({ meta, summary: truncated, session });
  if (text.length > PROMPT_BUDGET) return null;
  return { text, mode: "focused", markers: [SENTINEL] };
}

module.exports = {
  build,
  buildFull,
  buildFocused,
  renderInline,
  renderReference,
  renderFocused,
  SENTINEL,
  PROMPT_BUDGET,
};
