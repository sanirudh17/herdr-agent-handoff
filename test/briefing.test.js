const test = require("node:test");
const assert = require("node:assert/strict");
const { render, kickoff } = require("../lib/briefing.js");

const SNAPSHOT = {
  dir: "/state/handoffs/2026-07-25-pi-to-claude",
  totalLines: 4812,
  totalBytes: 862609,
  sha256: "deadbeef",
  counts: null,
  parts: [
    { name: "session/part-001.jsonl", lines: 1200, firstLine: 1, lastLine: 1200 },
    { name: "session/part-002.jsonl", lines: 1200, firstLine: 1201, lastLine: 2400 },
    { name: "session/part-003.jsonl", lines: 1200, firstLine: 2401, lastLine: 3600 },
    { name: "session/part-004.jsonl", lines: 1212, firstLine: 3601, lastLine: 4812 },
  ],
};

const META = {
  sourceKind: "pi", sourceName: "pi", sessionId: "abc", sourcePaneId: "w5:p1",
  workspaceId: "w5", tabId: "w5:t1", cwd: "/w/proj", destination: "tab",
  targetKind: "claude", targetName: "Claude Code", strategy: "file",
};

test("briefing states all six directives", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /read the complete source session/i);
  assert.match(text, /historical context/i);
  assert.match(text, /authoritative/i);
  assert.match(text, /uncommitted/i);
  assert.match(text, /exact stopping point/i);
  assert.match(text, /redo/i);
});

test("briefing lists every part with its line range and the totals", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  for (const part of SNAPSHOT.parts) {
    assert.ok(text.includes(part.name), `missing ${part.name}`);
    assert.ok(text.includes(`${part.firstLine}`), `missing first line ${part.firstLine}`);
  }
  assert.ok(text.includes("4,812") || text.includes("4812"));
  assert.ok(text.includes("4 part"));
});

test("briefing forbids writing to the handoff directory and touching the source", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /read-only/i);
  assert.match(text, /w5:p1/);
  assert.match(text, /do not/i);
});

test("briefing opens with an ordered set of actions, not a wall of rules", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  const doThis = text.indexOf("Do this, in this order");
  const rules = text.indexOf("The rules");
  assert.ok(doThis > 0, "the target needs concrete first actions");
  assert.ok(doThis < rules, "actions should come before the rules");
});

test("briefing forbids the status report agents default to", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /Do not write a report/i);
  assert.match(text, /one or two lines/i);
  assert.match(text, /handoff \*is\* the instruction|do not wait for a fresh instruction/i);
});

test("briefing says what to do when the task was already finished", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /already finished/i);
});

test("briefing covers non-coding work explicitly", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /notes|artifacts|conversation/i);
});

test("briefing names the source and target agents", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /\bpi\b/);
  assert.match(text, /Claude Code/);
});

test("briefing describes the sqlite export when that strategy was used", () => {
  const text = render({
    snapshot: { ...SNAPSHOT, counts: { session: 1, message: 12, part: 40, todo: 1, event: 135 } },
    meta: { ...META, sourceKind: "opencode", sourceName: "opencode", strategy: "sqlite" },
  });
  assert.match(text, /table/i);
  assert.match(text, /message/);
  assert.ok(text.includes("12"));
});

test("kickoff is a single line naming the briefing path", () => {
  const line = kickoff({ sourceName: "pi", handoffPath: "/state/h/HANDOFF.md" });
  assert.ok(!line.includes("\n"), "kickoff must not contain newlines");
  assert.ok(!line.includes("\r"), "kickoff must not contain carriage returns");
  assert.match(line, /pi/);
  assert.match(line, /\/state\/h\/HANDOFF\.md/);
  assert.match(line, /before doing anything else/i);
});
