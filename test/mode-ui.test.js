"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const modeUi = require("../lib/mode-ui.js");

function state(overrides = {}) {
  return modeUi.initialState({
    contextLine: "pi in Herdr · tab 1",
    width: 78,
    height: 20,
    ...overrides,
  });
}

const plain = (s) => modeUi.renderFrame(s).join("\n");

test("default selection is Focused handoff", () => {
  const s = state();
  assert.equal(s.cursor, 0);
  assert.equal(modeUi.MODES[0].id, "focused");
  assert.equal(modeUi.MODES[1].id, "full");
});

test("down and up change the selection", () => {
  let s = state();
  ({ state: s } = modeUi.applyKey(s, "down"));
  assert.equal(s.cursor, 1);
  ({ state: s } = modeUi.applyKey(s, "down"));
  assert.equal(s.cursor, 1, "stops at the end");
  ({ state: s } = modeUi.applyKey(s, "up"));
  assert.equal(s.cursor, 0);
  ({ state: s } = modeUi.applyKey(s, "up"));
  assert.equal(s.cursor, 0, "stops at the start");
});

test("vim j/k move like arrows", () => {
  let s = state();
  ({ state: s } = modeUi.applyKey(s, "j"));
  assert.equal(s.cursor, 1);
  ({ state: s } = modeUi.applyKey(s, "k"));
  assert.equal(s.cursor, 0);
});

test("enter returns the selected mode", () => {
  const focused = modeUi.applyKey(state(), "enter");
  assert.deepEqual(focused.action, { mode: "focused" });
  assert.equal(focused.state.chosen, "focused");

  let s = state();
  ({ state: s } = modeUi.applyKey(s, "down"));
  const full = modeUi.applyKey(s, "enter");
  assert.deepEqual(full.action, { mode: "full" });
});

test("digits jump straight to a mode", () => {
  assert.deepEqual(modeUi.applyKey(state(), "1").action, {
    mode: "focused",
  });
  assert.deepEqual(modeUi.applyKey(state(), "2").action, { mode: "full" });
});

test("escape, q and ctrl-c cancel", () => {
  for (const key of ["escape", "q", "ctrl-c"]) {
    assert.deepEqual(modeUi.applyKey(state(), key).action, {
      cancel: true,
    });
  }
});

test("rendered frame contains both options", () => {
  const text = plain(state());
  assert.match(text, /Focused handoff/);
  assert.match(text, /Full session transcript/);
});

test("focused is marked as the default", () => {
  assert.match(plain(state()), /Focused handoff.*default/i);
});

test("exactly one row carries the cursor marker", () => {
  const marked = modeUi.renderFrame(state()).filter((l) => l.includes("▸"));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /Focused handoff/);
});

test("clicking a row selects that mode", () => {
  const s = state();
  const row = modeUi
    .renderFrame(s)
    .findIndex((l) => l.includes("Full session"));
  assert.ok(row > 0);
  assert.deepEqual(modeUi.applyClick(s, row).action, { mode: "full" });
});

test("clicking outside the list does nothing", () => {
  assert.equal(modeUi.applyClick(state(), 0).action, null);
});

test("hovering a row highlights it without moving the cursor", () => {
  const s = state();
  const row = modeUi
    .renderFrame(s)
    .findIndex((l) => l.includes("Full session"));
  const hovered = modeUi.applyHover(s, row);
  assert.deepEqual(hovered.hover, { kind: "row", index: 1 });
  assert.equal(hovered.cursor, 0, "hover must not move the selection");
});

test("hovering nothing clears the highlight", () => {
  const s = modeUi.applyHover(state(), 5);
  assert.ok(s.hover);
  assert.equal(modeUi.applyHover(s, 0).hover, null);
});

test("no rendered line ever exceeds the pane width", () => {
  for (const width of [24, 34, 40, 78, 120]) {
    for (const line of modeUi.renderFrame(state({ width }))) {
      assert.ok(
        line.length <= Math.max(24, width),
        `width ${width}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("the confirmation frame names the chosen mode", () => {
  const out = modeUi.applyKey(state(), "enter");
  const text = modeUi.renderChosenFrame(out.state).join("\n");
  assert.match(text, /Focused handoff/);
  assert.match(text, /✓/);
});
