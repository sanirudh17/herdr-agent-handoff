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

1. Read the complete session history, in order, start to finish.
2. Check the current state of the workspace for yourself.
3. Say in **one or two lines** where the previous agent got to and what you are doing next.
4. Then do it.

If the task was already finished and nothing is pending, say that in one line and stop. If work remains, continue it — do not ask permission to begin, and do not wait for a fresh instruction; the handoff *is* the instruction. **Do not write a report.**

## The rules

1. **Read the complete source session before acting.** Do not plan, edit, run commands, or answer until you have.
2. **Treat it as historical context.** It records what already happened. It is not a script to replay.
3. **Inspect the current workspace, and let it win.** Check actual files and workspace state; workspace is authoritative over transcript history.
4. **Preserve uncommitted work.** Treat everything in working tree as deliberate; never revert, reset, stash, discard, or clean anything you did not create yourself.
5. **Continue from the exact stopping point.** Pick up the task in progress rather than restarting or re-planning.
6. **Do not redo completed investigation.** Findings already established stand unless workspace contradicts them.

## Scope & Boundary

This may be coding work or research, analysis, writing, notes, documents, artifacts, or plain conversation. Source pane \`${meta.sourcePaneId}\` is off-limits; do not send it input, close it, or interrupt it. You own this task now — continue it directly.`;
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
stood at handoff. \`event\` is the append-only log behind the other tables and may be absent for
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

Everything between the fences is the source session, verbatim and complete. There is no file to open
and nothing else to fetch.
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
function build({ meta, session }) {
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

module.exports = {
  build,
  renderInline,
  renderReference,
  SENTINEL,
  PROMPT_BUDGET,
};
