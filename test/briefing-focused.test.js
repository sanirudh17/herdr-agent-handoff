"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodePath = require("node:path");
const {
  build,
  buildFull,
  buildFocused,
  renderFocused,
  SENTINEL,
  PROMPT_BUDGET,
} = require("../lib/briefing.js");

const NATIVE_PATH = nodePath.join("C:", "x", "rollout-1.jsonl");

const META = {
  sourceKind: "codex",
  sourceName: "Codex",
  targetKind: "claude",
  targetName: "Claude Code",
  sessionId: "019d4393-fd0e-77f2-88a2-782589d290a5",
  sourcePaneId: "w6:p1",
  workspaceId: "w6",
  tabId: "w6:t1",
  cwd: "C:\\Users\\sanir\\Herdr plugin",
  destination: "tab",
  strategy: "file",
  snapshotUtc: "2026-07-26T09:30:00.000Z",
};

function sessionOf(text) {
  const body = Buffer.from(text, "utf8");
  return {
    strategy: "file",
    nativePath: NATIVE_PATH,
    body,
    bytes: body.length,
    lines: text.split("\n").length - 1,
    sha256: "a".repeat(64),
    counts: null,
    readable: true,
  };
}

const SUMMARY = `# Focused Handoff

## Current objective
- Ship the fix.

## Completed work
- Diagnosed the parser and fixed it in lib/a.js.

## Current state
- Complete, tests pass.

## Remaining work
- No remaining work identified.

## Important constraints / user preferences
- None.

## Pitfalls / do not redo
- Do not re-run the old regex diagnosis; it is solved.

## Relevant files
- lib/a.js — the fix.
`;

test("build stays as the full-transcript entry point", () => {
  const session = sessionOf('{"n":1}\n');
  const viaBuild = build({ meta: META, session });
  const viaFull = buildFull({ meta: META, session });
  assert.deepEqual(viaBuild, viaFull);
  assert.ok(["inline", "reference"].includes(viaBuild.mode));
});

test("full mode still embeds the transcript exactly", () => {
  const transcript = '{"role":"user","text":"hello"}\n';
  const built = buildFull({ meta: META, session: sessionOf(transcript) });
  assert.ok(built.text.includes(transcript));
});

test("focused mode includes the summary", () => {
  const text = renderFocused({
    meta: META,
    summary: SUMMARY,
    session: sessionOf('{"n":1}\n'),
  });
  assert.ok(text.includes("Ship the fix."));
  assert.ok(text.includes("Handoff mode: focused"));
});

test("focused mode does NOT include the full transcript body", () => {
  const transcript = `{"unique-marker":"focused-must-not-leak-12345"}\n`;
  const text = renderFocused({
    meta: META,
    summary: SUMMARY,
    session: sessionOf(transcript),
  });
  assert.ok(!text.includes("focused-must-not-leak-12345"));
  const built = buildFocused({
    meta: META,
    summary: SUMMARY,
    session: sessionOf(transcript),
  });
  assert.ok(!built.text.includes("focused-must-not-leak-12345"));
});

test("focused mode tells the target not to redo or replay history", () => {
  const text = renderFocused({
    meta: META,
    summary: SUMMARY,
    session: null,
  }).toLowerCase();
  assert.ok(text.includes("do not redo completed work"));
  assert.ok(text.includes("do not replay old transcript"));
  assert.ok(text.includes("must not be replayed"));
  assert.ok(text.includes("do not re-run the same searches"));
});

test("focused mode ends in stop-and-wait, never autonomous action", () => {
  const text = renderFocused({ meta: META, summary: SUMMARY, session: null });
  assert.match(text, /medium-length status summary/);
  assert.match(text, /Send it before anything else/);
  assert.match(text, /STOP\./);
  assert.match(text, /Wait for the user's next instruction/);
  assert.match(text, /context transfer, not an order to begin/);
  assert.ok(!text.includes("proceed directly"));
});

test("the focused status message is a medium-length flowing summary", () => {
  const text = renderFocused({ meta: META, summary: SUMMARY, session: null });
  assert.match(text, /medium-length status summary/);
  assert.match(text, /150.250 words/);
  for (const part of [
    "background and objective",
    "completed work with key files and decisions",
    "current state and stopping point",
    "next steps",
  ]) {
    assert.ok(text.includes(part), `status shape must cover ${part}`);
  }
  for (const bullet of [
    "**Objective**",
    "**Done**",
    "**Stopping point**",
    "**Next**",
  ]) {
    assert.ok(!text.includes(bullet), `no bullet template anymore: ${bullet}`);
  }
});

test("focused mode declares previous todos a record, not a work order", () => {
  const text = renderFocused({ meta: META, summary: SUMMARY, session: null });
  assert.match(text, /record, not a work order/i);
  assert.match(text, /never re-create or re-execute them blindly/i);
});

test("a complete focused task stops without re-verifying", () => {
  const text = renderFocused({ meta: META, summary: SUMMARY, session: null });
  assert.match(text, /do not re-verify by re-implementing/i);
  assert.match(text, /touch the todo list/i);
});

test("focused mode labels any transcript reference as optional fallback only", () => {
  const text = renderFocused({
    meta: META,
    summary: SUMMARY,
    session: sessionOf('{"n":1}\n'),
  });
  assert.match(text, /Optional transcript fallback/);
  assert.match(text, /Do not read or replay it by default/);
  assert.ok(text.includes(NATIVE_PATH));
  assert.match(text, /fallback only/i);
});

test("focused mode without a safe reference says unavailable", () => {
  const text = renderFocused({ meta: META, summary: SUMMARY, session: null });
  assert.match(text, /Optional transcript fallback/);
  assert.match(text, /No safe transcript reference available/);
});

test("focused mode never points at a sqlite database blob", () => {
  const session = {
    ...sessionOf('{"n":1}\n'),
    strategy: "sqlite",
    nativePath: nodePath.join("C:", "db", "opencode.db"),
    counts: { session: 1 },
  };
  const text = renderFocused({ meta: META, summary: SUMMARY, session });
  assert.ok(!text.includes("opencode.db"));
  assert.match(text, /No safe transcript reference available/);
});

test("focused mode ends with the sentinel", () => {
  const built = buildFocused({
    meta: META,
    summary: SUMMARY,
    session: null,
  });
  assert.equal(built.mode, "focused");
  assert.deepEqual(built.markers, [SENTINEL]);
  assert.ok(built.text.trimEnd().endsWith(SENTINEL));
});

test("focused mode stays under the prompt budget", () => {
  const built = buildFocused({
    meta: META,
    summary: SUMMARY,
    session: sessionOf('{"n":1}\n'),
  });
  assert.ok(built.text.length <= PROMPT_BUDGET);
});

test("an over-long summary is truncated, never overflowed", () => {
  const long = `summary line ${"x".repeat(100)}\n`.repeat(600);
  const built = buildFocused({ meta: META, summary: long, session: null });
  assert.ok(built, "should truncate rather than fail");
  assert.ok(built.text.length <= PROMPT_BUDGET);
  assert.match(built.text, /truncated to fit prompt budget/);
});

test("an empty summary yields no prompt", () => {
  assert.equal(
    buildFocused({ meta: META, summary: "   ", session: null }),
    null,
  );
});
