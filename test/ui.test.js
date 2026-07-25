const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../lib/ui.js");

const INSTALLED = [
  { kind: "claude", name: "Claude Code" },
  { kind: "codex", name: "Codex" },
  { kind: "pi", name: "pi", isSource: true },
  { kind: "grok", name: "Grok" },
];

const NOT_INSTALLED = Array.from({ length: 14 }, (_, i) => ({
  kind: `u${i}`,
  name: `Unavailable ${i}`,
}));

function state(overrides = {}) {
  return ui.initialState({
    contextLine: "pi in Herdr · tab 1 · 18 lines",
    destination: "split beside it",
    installed: INSTALLED,
    notInstalled: NOT_INSTALLED,
    width: 78,
    height: 20,
    ...overrides,
  });
}

const plain = (s) => ui.renderFrame(s).join("\n");

test("decodeInput maps arrows, vim keys, tab, enter, escape and digits", () => {
  const seen = (buf) => ui.decodeInput(Buffer.from(buf)).map((e) => e.name);
  assert.deepEqual(seen("\x1b[A"), ["up"]);
  assert.deepEqual(seen("\x1b[B"), ["down"]);
  assert.deepEqual(seen("\x1b[5~"), ["pageup"]);
  assert.deepEqual(seen("\x1b[6~"), ["pagedown"]);
  assert.deepEqual(seen("\t"), ["tab"]);
  assert.deepEqual(seen("\x1b[Z"), ["shift-tab"]);
  assert.deepEqual(seen("j"), ["j"]);
  assert.deepEqual(seen("\r"), ["enter"]);
  assert.deepEqual(seen("\x1b"), ["escape"]);
  assert.deepEqual(seen("\x03"), ["ctrl-c"]);
  assert.deepEqual(seen("?"), ["?"]);
  assert.deepEqual(seen("3"), ["3"]);
});

test("decodeInput parses an SGR mouse press and ignores the release", () => {
  const press = ui.decodeInput(Buffer.from("\x1b[<0;10;7M"));
  assert.equal(press[0].type, "mouse");
  assert.equal(press[0].row, 6);
  assert.deepEqual(ui.decodeInput(Buffer.from("\x1b[<0;10;7m")), []);
});

// --- the wrapping bug -------------------------------------------------------

test("no rendered line ever exceeds the pane width", () => {
  for (const width of [34, 40, 56, 78, 120]) {
    const frame = ui.renderFrame(state({ width }));
    for (const line of frame) {
      assert.ok(
        line.length <= Math.max(24, width),
        `width ${width}: line of ${line.length} chars would wrap: ${JSON.stringify(line)}`
      );
    }
  }
});

test("the source tag is dropped rather than wrapped when there is no room", () => {
  const narrow = plain(state({ width: 34 }));
  assert.ok(!narrow.includes("fresh session"), "tag must be omitted at 34 columns");
  const wide = plain(state({ width: 78 }));
  assert.match(wide, /fresh session/, "tag should appear when it fits");
});

test("long agent names are truncated, not wrapped", () => {
  const long = [{ kind: "verylongkind", name: "An Extremely Long Agent Name That Cannot Fit" }];
  const frame = ui.renderFrame(state({ installed: long, width: 40 }));
  for (const line of frame) assert.ok(line.length <= 40);
  assert.match(frame.join("\n"), /…/);
});

// --- no duplicate title -----------------------------------------------------

test("the frame does not repeat the popup border title", () => {
  assert.ok(
    !plain(state()).includes("Handoff to Agent"),
    "Herdr already draws the title on the popup border"
  );
});

// --- sections and scrolling -------------------------------------------------

test("tab switches between the installed and not-installed sections", () => {
  let s = state();
  assert.equal(s.section, "installed");
  ({ state: s } = ui.applyKey(s, "tab"));
  assert.equal(s.section, "notInstalled");
  ({ state: s } = ui.applyKey(s, "tab"));
  assert.equal(s.section, "installed");
});

test("? jumps to the not-installed section and back", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.section, "notInstalled");
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.section, "installed");
});

test("the not-installed section scrolls all the way to the last entry", () => {
  let s = state({ height: 14 });
  ({ state: s } = ui.applyKey(s, "tab"));
  for (let i = 0; i < 30; i += 1) ({ state: s } = ui.applyKey(s, "down"));
  const text = plain(s);
  assert.match(text, /Unavailable 13/, "the final not-installed agent must be reachable");
});

test("page keys scroll the not-installed section", () => {
  let s = state({ height: 14 });
  ({ state: s } = ui.applyKey(s, "tab"));
  const before = s.scroll.notInstalled;
  ({ state: s } = ui.applyKey(s, "pagedown"));
  assert.ok(s.scroll.notInstalled > before);
});

test("switching sections never hides installed agents", () => {
  let s = state();
  const visibleInstalled = (text) => INSTALLED.filter((a) => text.includes(a.name)).length;
  assert.equal(visibleInstalled(plain(s)), INSTALLED.length);
  ({ state: s } = ui.applyKey(s, "tab"));
  ({ state: s } = ui.applyKey(s, "tab"));
  assert.equal(visibleInstalled(plain(s)), INSTALLED.length);
});

test("with nothing missing there is no second section to switch to", () => {
  let s = state({ notInstalled: [] });
  ({ state: s } = ui.applyKey(s, "tab"));
  assert.equal(s.section, "installed");
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.section, "installed");
});

// --- selection --------------------------------------------------------------

test("cursor movement stops at both ends", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "up"));
  assert.equal(s.cursor, 0);
  for (let i = 0; i < 10; i += 1) ({ state: s } = ui.applyKey(s, "down"));
  assert.equal(s.cursor, INSTALLED.length - 1);
});

test("enter selects the agent under the cursor", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "down"));
  const out = ui.applyKey(s, "enter");
  assert.deepEqual(out.action, { select: "codex" });
  assert.equal(out.state.chosen, "codex");
});

test("digits jump straight to an agent and select it", () => {
  const out = ui.applyKey(state(), "3");
  assert.deepEqual(out.action, { select: "pi" });
});

test("nothing in the not-installed section is selectable", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "tab"));
  assert.equal(ui.applyKey(s, "enter").action, null);
  assert.equal(ui.applyKey(s, "1").action, null);
});

test("escape, q and ctrl-c cancel", () => {
  for (const key of ["escape", "q", "ctrl-c"]) {
    assert.deepEqual(ui.applyKey(state(), key).action, { cancel: true });
  }
});

test("clicking an installed row selects it", () => {
  const s = state();
  const row = ui.renderFrame(s).findIndex((l) => l.includes("Codex"));
  assert.ok(row > 0);
  assert.deepEqual(ui.applyClick(s, row).action, { select: "codex" });
});

test("clicking outside the installed list does nothing", () => {
  const s = state();
  assert.equal(ui.applyClick(s, 0).action, null);
  let notInstalled = state();
  ({ state: notInstalled } = ui.applyKey(notInstalled, "tab"));
  const row = ui.renderFrame(notInstalled).findIndex((l) => l.includes("Unavailable 0"));
  assert.ok(row > 0);
  assert.equal(ui.applyClick(notInstalled, row).action, null);
});

// --- chrome -----------------------------------------------------------------

test("the frame shows section tabs, the counter, the summary and footer chips", () => {
  const text = plain(state());
  assert.match(text, /installed \(4\)/);
  assert.match(text, /not installed \(14\)/);
  assert.match(text, /4 \/ 18 available/);
  assert.match(text, /pi in Herdr · tab 1 · 18 lines/);
  assert.match(text, /split beside it/);
  assert.match(text, /⏎ hand off/);
  assert.match(text, /esc cancel/);
  assert.match(text, /tab section/);
});

test("no raw pane or workspace ids leak into the frame", () => {
  const text = plain(state());
  assert.ok(!/w\d+:[pt]\d+/.test(text), `frame should not show ids like w5:p1: ${text}`);
});

test("exactly one row carries the cursor marker", () => {
  const marked = ui.renderFrame(state()).filter((l) => l.includes("▸"));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /Claude Code/);
});

test("styled output paints selected chrome in the theme accent, never reverse video", () => {
  const frame = ui.renderFrame(state(), { styled: true });
  const all = frame.join("\n");
  assert.ok(!all.includes("\x1b[7m"), "reverse video ignores the theme and must not be used");

  const cursorRow = frame.find((l) => l.includes("Claude Code"));
  assert.match(cursorRow, /\x1b\[44m/, "cursor row should use the accent background");
  assert.match(cursorRow, /\x1b\[30m/, "accent fills carry dark text for contrast");
  assert.match(frame[0], /\x1b\[44m/, "the active section tab should use the accent too");
  assert.match(frame[0], /\x1b\[2m/, "counter should be dimmed");
  assert.match(frame[frame.length - 1], /\x1b\[44m/, "the primary chip should use the accent");
});

test("a configured accent overrides the default", () => {
  const magenta = ui.renderFrame(state({ accent: { kind: "index", index: 5 } }), { styled: true });
  assert.match(magenta.find((l) => l.includes("Claude Code")), /\x1b\[45m/);

  const hex = ui.renderFrame(
    state({ accent: { kind: "rgb", r: 137, g: 180, b: 250 } }),
    { styled: true }
  );
  assert.match(hex.find((l) => l.includes("Claude Code")), /\x1b\[48;2;137;180;250m/);
});

test("the frame respects the declared height", () => {
  for (const height of [10, 14, 20, 30]) {
    assert.ok(ui.renderFrame(state({ height })).length <= height);
  }
});

test("the confirmation frame names the chosen agent", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "down"));
  const out = ui.applyKey(s, "enter");
  const text = ui.renderChosenFrame(out.state).join("\n");
  assert.match(text, /handing off to Codex/);
  assert.match(text, /✓/);
});
