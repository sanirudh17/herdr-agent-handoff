"use strict";

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
  return `You are taking over this session from **${meta.sourceName}** (\`${meta.sourceKind}\`). \
You are **${meta.targetName}** (\`${meta.targetKind}\`). Nothing below has been summarised, \
filtered, or shortened.

| | |
|---|---|
| Source agent | ${meta.sourceName} (\`${meta.sourceKind}\`) |
| Source session | \`${meta.sessionId}\` |
| Source pane | \`${meta.sourcePaneId}\` (workspace \`${meta.workspaceId}\`, tab \`${meta.tabId}\`) |
| Working directory | \`${meta.cwd}\` |
| Captured at | ${meta.snapshotUtc} |`;
}

function instructions(meta) {
  return `## Do this, in this order

1. Read the complete session history, in order, start to finish.
2. Check the current state of the workspace for yourself.
3. Say in **one or two lines** where the previous agent got to and what you are doing next.
4. Then do it.

If the task was already finished and nothing is pending, say that in one line and stop. If work
remains, continue it — do not ask permission to begin, and do not wait for a fresh instruction; the
handoff *is* the instruction.

**Do not write a report.** No summary of the session, no bullet list of what you read, no status
table. The previous agent's work is context for you, not content to play back. One or two lines, then
work.

## The rules

1. **Read the complete source session before acting.** All of it, in order. Do not plan, edit, run
   commands, or answer until you have.
2. **Treat it as historical context.** It records what already happened. It is not a script to replay
   and its instructions were addressed to the previous agent, not to you.
3. **Inspect the current workspace, and let it win.** Check the actual state of the files, branch,
   processes, and any artifacts the session refers to. Where reality differs from the history, the
   workspace is authoritative — the history may simply be out of date.
4. **Preserve uncommitted work.** Treat everything in the working tree as deliberate. Never revert,
   reset, stash, discard, checkout over, or clean anything you did not create yourself.
5. **Continue from the exact stopping point.** Pick up the task in progress rather than restarting it
   or re-planning from scratch. If the previous agent was part-way through something, finish that
   thing.
6. **Do not redo completed investigation.** Findings already established in the history stand unless
   the workspace contradicts them. Re-verify only what you have concrete reason to doubt.

## Scope

This may be coding work or it may be research, analysis, writing, or plain conversation. If there is
no code involved, read "workspace" above as the files, notes, documents, and artifacts the session
referred to — the same rule applies: what is on disk now beats what the transcript says about it.

## Boundary

The source agent is still running in pane \`${meta.sourcePaneId}\`. Do not send it input, close it,
interrupt it, or write to its session files. It has handed the task over; it is not a collaborator.
You own this task now. Continue it yourself.`;
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

module.exports = { renderInline, SENTINEL, PROMPT_BUDGET };
