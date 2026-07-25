const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../lib/ui.js");

const AVAILABLE = [
  { kind: "claude", name: "Claude Code" },
  { kind: "codex", name: "Codex" },
  { kind: "pi", name: "pi", isSource: true },
  { kind: "grok", name: "Grok" },
];

function state(overrides = {}) {
  return ui.initialState({
    title: "Handoff to Agent",
    contextLine: "pi · w5:p1 · 4,812 lines  →  new tab in workspace 5",
    available: AVAILABLE,
    unavailable: [{ kind: "gemini", name: "Gemini CLI (deprecated)" }],
    unavailableCount: 14,
    width: 78,
    height: 20,
    ...overrides,
  });
}

test("decodeInput maps arrows, vim keys, enter, escape and digits", () => {
  const seen = (buf) => ui.decodeInput(Buffer.from(buf)).map((e) => e.name);
  assert.deepEqual(seen("\x1b[A"), ["up"]);
  assert.deepEqual(seen("\x1b[B"), ["down"]);
  assert.deepEqual(seen("j"), ["j"]);
  assert.deepEqual(seen("k"), ["k"]);
  assert.deepEqual(seen("\r"), ["enter"]);
  assert.deepEqual(seen("\n"), ["enter"]);
  assert.deepEqual(seen("\x1b"), ["escape"]);
  assert.deepEqual(seen("q"), ["q"]);
  assert.deepEqual(seen("\x03"), ["ctrl-c"]);
  assert.deepEqual(seen("?"), ["?"]);
  assert.deepEqual(seen("3"), ["3"]);
});

test("decodeInput parses an SGR mouse press into zero-indexed coordinates", () => {
  const events = ui.decodeInput(Buffer.from("\x1b[<0;10;7M"));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "mouse");
  assert.equal(events[0].col, 9);
  assert.equal(events[0].row, 6);
});

test("decodeInput ignores mouse release events", () => {
  assert.deepEqual(ui.decodeInput(Buffer.from("\x1b[<0;10;7m")), []);
});

test("cursor starts on the first available agent", () => {
  assert.equal(state().cursor, 0);
});

test("down and up move the cursor and stop at the ends", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "down"));
  assert.equal(s.cursor, 1);
  ({ state: s } = ui.applyKey(s, "up"));
  assert.equal(s.cursor, 0);
  ({ state: s } = ui.applyKey(s, "up"));
  assert.equal(s.cursor, 0, "must not wrap past the top");
  for (let i = 0; i < 10; i += 1) ({ state: s } = ui.applyKey(s, "down"));
  assert.equal(s.cursor, AVAILABLE.length - 1, "must not wrap past the bottom");
});

test("enter selects the agent under the cursor", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "down"));
  const { action } = ui.applyKey(s, "enter");
  assert.deepEqual(action, { select: "codex" });
});

test("digits jump straight to an agent and select it", () => {
  const { action } = ui.applyKey(state(), "3");
  assert.deepEqual(action, { select: "pi" });
});

test("a digit beyond the list does nothing", () => {
  const { action } = ui.applyKey(state(), "9");
  assert.equal(action, null);
});

test("escape, q and ctrl-c cancel", () => {
  for (const key of ["escape", "q", "ctrl-c"]) {
    assert.deepEqual(ui.applyKey(state(), key).action, { cancel: true });
  }
});

test("? toggles the unavailable block without moving the cursor", () => {
  let s = state();
  assert.equal(s.showUnavailable, false);
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.showUnavailable, true);
  assert.equal(s.cursor, 0);
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.showUnavailable, false);
});

test("clicking an agent row selects it", () => {
  const s = state();
  const frame = ui.renderFrame(s);
  const row = frame.findIndex((line) => line.includes("Codex"));
  assert.ok(row > 0, "Codex should be rendered");
  assert.deepEqual(ui.applyClick(s, row).action, { select: "codex" });
});

test("clicking a non-agent row does nothing", () => {
  const s = state();
  assert.equal(ui.applyClick(s, 0).action, null);
});

test("clicking inside the revealed unavailable block does nothing", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "?"));
  const frame = ui.renderFrame(s);
  const row = frame.findIndex((line) => line.includes("Gemini"));
  assert.ok(row > 0);
  assert.equal(ui.applyClick(s, row).action, null);
});

test("frame shows the title, availability count, context line and footer", () => {
  const text = ui.renderFrame(state()).join("\n");
  assert.match(text, /Handoff to Agent/);
  assert.match(text, /4 \/ 18 available/);
  assert.match(text, /w5:p1/);
  assert.match(text, /14 more supported agents not installed/);
  assert.match(text, /enter select/);
  assert.match(text, /esc cancel/);
});

test("frame marks the source agent as a fresh session", () => {
  const text = ui.renderFrame(state()).join("\n");
  assert.match(text, /same agent, fresh session/);
});

test("frame marks the cursor row and only that row", () => {
  const marked = ui.renderFrame(state()).filter((l) => l.trimStart().startsWith("▸"));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /Claude Code/);
});

test("frame scrolls when the roster exceeds the viewport", () => {
  const many = Array.from({ length: 21 }, (_, i) => ({ kind: `k${i}`, name: `Agent ${i}` }));
  let s = state({ available: many, height: 14, unavailableCount: 0, unavailable: [] });
  for (let i = 0; i < 20; i += 1) ({ state: s } = ui.applyKey(s, "down"));
  const text = ui.renderFrame(s).join("\n");
  assert.match(text, /Agent 20/, "cursor row must stay visible");
  assert.ok(ui.renderFrame(s).length <= 14, "frame must respect the height");
});
