"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderInline, SENTINEL, PROMPT_BUDGET } = require("../lib/briefing.js");

const META = {
  sourceKind: "codex", sourceName: "Codex",
  targetKind: "claude", targetName: "Claude Code",
  sessionId: "019d4393-fd0e-77f2-88a2-782589d290a5",
  sourcePaneId: "w6:p1", workspaceId: "w6", tabId: "w6:t1",
  cwd: "C:\\Users\\sanir\\Herdr plugin",
  destination: "tab", strategy: "file",
  snapshotUtc: "2026-07-26T09:30:00.000Z",
};

function sessionOf(text) {
  const body = Buffer.from(text, "utf8");
  return {
    strategy: "file", nativePath: "C:\\x\\rollout-1.jsonl", body,
    bytes: body.length, lines: text.split("\n").length - 1,
    sha256: "a".repeat(64), counts: null, readable: true,
  };
}

const inlineOf = (text) => renderInline({ meta: META, session: sessionOf(text) });

test("the prompt opens by telling the target it is taking over, and names the source", () => {
  assert.match(inlineOf('{"n":1}\n'), /^You are taking over this session from \*\*Codex\*\*/,
    "this exact opening was the requirement");
});

test("the transcript is embedded verbatim, byte for byte", () => {
  const transcript = '{"role":"user","text":"hello ─ ❯ world"}\n{"role":"assistant"}\n';
  assert.ok(inlineOf(transcript).includes(transcript), "no escaping, no reflowing, no truncation");
});

test("the prompt states what to verify the transcript against", () => {
  const s = sessionOf('{"n":1}\n');
  const text = renderInline({ meta: META, session: s });
  assert.ok(text.includes(s.sha256), "the hash is stated so the target can confirm");
  assert.ok(text.includes(String(s.bytes)), "so is the byte count");
});

test("all six rules survive into the prompt", () => {
  const text = inlineOf('{"n":1}\n').toLowerCase();
  for (const rule of [
    "read the complete source session before acting",
    "treat it as historical context",
    "inspect the current workspace",
    "preserve uncommitted work",
    "continue from the exact stopping point",
    "do not redo completed investigation",
  ]) {
    assert.ok(text.includes(rule), `missing rule: ${rule}`);
  }
});

test("the prompt opens with an ordered set of actions, not a wall of rules", () => {
  const text = inlineOf('{"n":1}\n');
  const doThis = text.indexOf("Do this, in this order");
  const rules = text.indexOf("The rules");
  assert.ok(doThis > 0, "the target needs concrete first actions");
  assert.ok(doThis < rules, "actions should come before the rules");
});

test("the prompt forbids the status report agents default to", () => {
  const text = inlineOf('{"n":1}\n');
  assert.match(text, /Do not write a report/i);
  assert.match(text, /one or two lines/i);
  assert.match(text, /handoff \*is\* the instruction|do not wait for a fresh instruction/i);
});

test("the prompt says what to do when the task was already finished", () => {
  assert.match(inlineOf('{"n":1}\n'), /already finished/i);
});

test("the prompt covers non-coding work explicitly", () => {
  assert.match(inlineOf('{"n":1}\n'), /notes|artifacts|conversation/i);
});

test("the prompt names both agents", () => {
  const text = inlineOf('{"n":1}\n');
  assert.match(text, /Codex/);
  assert.match(text, /Claude Code/);
});

test("the source pane is declared off limits and named", () => {
  const text = inlineOf('{"n":1}\n');
  assert.ok(text.includes("w6:p1"));
  assert.match(text, /do not send it input/i);
});

test("the sqlite export is explained when that strategy was used", () => {
  const session = {
    ...sessionOf('{"table":"session"}\n'),
    strategy: "sqlite",
    counts: { session: 1, message: 12, part: 40, todo: 1, event: 135 },
  };
  const text = renderInline({
    meta: { ...META, sourceKind: "opencode", sourceName: "opencode", strategy: "sqlite" },
    session,
  });
  assert.match(text, /table/i);
  assert.match(text, /message/);
  assert.ok(text.includes("12"));
});

test("the prompt ends with the sentinel, because that is the delivery marker", () => {
  const text = inlineOf('{"n":1}\n');
  assert.ok(text.trimEnd().endsWith(SENTINEL), "the marker must be the last thing on screen");
  assert.equal(SENTINEL, "-- end of handoff, begin now --");
});

test("no reference to a handoff document survives", () => {
  const text = inlineOf('{"n":1}\n');
  assert.ok(!text.includes("HANDOFF.md"), "there is no document any more");
  assert.ok(!text.includes("SOURCE.json"));
});

test("the prose alone leaves real room for a transcript", () => {
  const overhead = inlineOf("").length;
  assert.ok(overhead < 5000, `prose overhead is ${overhead}; it must leave >25k for the transcript`);
  assert.equal(PROMPT_BUDGET, 30000);
});

test("briefing no longer offers the document-era API", () => {
  const briefing = require("../lib/briefing.js");
  assert.equal(briefing.kickoff, undefined);
  assert.equal(briefing.partsTable, undefined);
  assert.equal(briefing.render, undefined);
});
