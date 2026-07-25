const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ui = require("../lib/ui.js");
const themeLib = require("../lib/theme.js");

function configWith(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-ui-theme-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, `[theme]\nname = "${name}"\n`);
  return file;
}

const catppuccin = { palette: themeLib.resolveTheme(configWith("catppuccin")).palette };
// Rows above the agent list: tabs, blank, context, blank.
const HEADER_ROWS_FOR_TEST = 4;

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

test("mouse motion is reported as hover, distinct from a press", () => {
  const move = ui.decodeInput(Buffer.from("\x1b[<35;10;7M"));
  assert.equal(move[0].type, "hover", "bit 5 marks motion");
  const press = ui.decodeInput(Buffer.from("\x1b[<0;10;7M"));
  assert.equal(press[0].type, "mouse");
});

test("hovering a tab highlights it without switching sections", () => {
  const s = state();
  const col = ui.renderFrame(s)[0].indexOf("not installed");
  const hovered = ui.applyHover(s, 0, col);
  assert.deepEqual(hovered.hover, { kind: "tab", key: "notInstalled" });
  assert.equal(hovered.section, "installed", "hover must not change the section");

  const styled = ui.renderFrame({ ...hovered, theme: catppuccin }, { styled: true })[0];
  const plainStyled = ui.renderFrame({ ...s, theme: catppuccin }, { styled: true })[0];
  assert.notEqual(styled, plainStyled, "the hovered tab should look different");
});

test("hovering an agent row highlights the whole row", () => {
  const s = state({ theme: catppuccin });
  const row = ui.renderFrame(s).findIndex((l) => l.includes("Codex"));
  const hovered = ui.applyHover(s, row, 5);
  assert.deepEqual(hovered.hover, { kind: "row", section: "installed", index: 1 });

  const line = ui.renderFrame(hovered, { styled: true })[row];
  // catppuccin overlay0, spanning the full width.
  assert.match(line, /\x1b\[48;2;108;112;134m/);
});

test("hover, selection and the active tab are three different colours", () => {
  const s = { ...state({ theme: catppuccin }) };
  const row = ui.renderFrame(s).findIndex((l) => l.includes("Codex"));
  const hovered = ui.renderFrame(ui.applyHover(s, row, 5), { styled: true });
  const cursorLine = hovered[HEADER_ROWS_FOR_TEST];
  const hoverLine = hovered[row];
  const tab = hovered[0];

  const bgOf = (line) => (line.match(/\x1b\[48;2;\d+;\d+;\d+m/) || [""])[0];
  assert.notEqual(bgOf(hoverLine), bgOf(cursorLine), "hover must differ from selection");
  assert.notEqual(bgOf(hoverLine), bgOf(tab), "hover must differ from the accent");
  assert.notEqual(bgOf(cursorLine), bgOf(tab), "selection must differ from the accent");
});

test("hover highlights span the full width, like the cursor row", () => {
  const s = state({ theme: catppuccin });
  const row = ui.renderFrame(s).findIndex((l) => l.includes("Codex"));
  const hovered = ui.applyHover(s, row, 5);
  const plain = ui.renderFrame(hovered)[row];
  assert.equal(plain.length, 78, "a highlighted row must fill the pane width");
  const cursor = ui.renderFrame(s)[HEADER_ROWS_FOR_TEST];
  assert.equal(cursor.length, 78, "so must the cursor row");
});

test("hovering the not-installed section works too", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "tab"));
  const row = ui.renderFrame(s).findIndex((l) => l.includes("Unavailable 1"));
  const hovered = ui.applyHover(s, row, 5);
  assert.deepEqual(hovered.hover, { kind: "row", section: "notInstalled", index: 1 });
});

test("hovering nothing clears the highlight", () => {
  const s = ui.applyHover(state(), 0, 2);
  assert.ok(s.hover);
  const cleared = ui.applyHover(s, 2, 5);
  assert.equal(cleared.hover, null);
});

test("both tab chips are the same width so the fill is symmetrical", () => {
  const header = ui.renderFrame(state())[0];
  const width = "not installed (14)".length; // the longer label sets the chip width
  assert.ok(
    header.includes(` ${"installed (4)".padEnd(width)} `),
    `the shorter chip should be padded to match: ${JSON.stringify(header)}`
  );
  assert.ok(header.includes(` ${"not installed (14)".padEnd(width)} `));
});

test("the accent fill covers the whole chip, not just the label", () => {
  const frame = ui.renderFrame(state({ theme: catppuccin }), { styled: true });
  const accentStart = frame[0].indexOf("\x1b[48;2;137;180;250m");
  assert.ok(accentStart >= 0, "the active chip should be filled");
  // Everything from the fill up to the reset is one accent run, padding included.
  const run = frame[0].slice(accentStart).split("\x1b[0m")[0];
  assert.match(run, /installed \(4\) {5} $/, "padding must be inside the fill");
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

test("right and left arrows move between sections", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "right"));
  assert.equal(s.section, "notInstalled", "right arrow should reach the not-installed tab");
  ({ state: s } = ui.applyKey(s, "left"));
  assert.equal(s.section, "installed");
});

test("vim h and l also move between sections", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "l"));
  assert.equal(s.section, "notInstalled");
  ({ state: s } = ui.applyKey(s, "h"));
  assert.equal(s.section, "installed");
});

test("clicking a tab label switches to that section", () => {
  const s = state();
  const header = ui.renderFrame(s)[0];
  const col = header.indexOf("not installed");
  assert.ok(col > 0, `expected a not-installed tab in ${JSON.stringify(header)}`);
  const out = ui.applyClick(s, 0, col);
  assert.equal(out.state.section, "notInstalled");
  assert.equal(out.action, null, "switching sections is not a selection");

  const back = ui.applyClick(out.state, 0, ui.renderFrame(out.state)[0].indexOf("installed"));
  assert.equal(back.state.section, "installed");
});

test("clicking empty space in the tab row does nothing", () => {
  const s = state();
  const out = ui.applyClick(s, 0, 70);
  assert.equal(out.state.section, "installed");
  assert.equal(out.action, null);
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

test("styled output reproduces Herdr's settings-modal styling, never reverse video", () => {
  const frame = ui.renderFrame(state({ theme: catppuccin }), { styled: true });
  const all = frame.join("\n");
  assert.ok(!all.includes("\x1b[7m"), "reverse video ignores the theme and must not be used");

  // Selected row: surface0 fill with normal text, as Herdr's list highlight does.
  const cursorRow = frame.find((l) => l.includes("Claude Code"));
  assert.match(cursorRow, /\x1b\[48;2;49;50;68m/, "cursor row uses surface0");
  assert.match(cursorRow, /\x1b\[38;2;205;214;244m/, "cursor row uses normal text");

  // Active tab and primary chip: accent fill with the panel background as text.
  assert.match(frame[0], /\x1b\[48;2;137;180;250m/, "active tab uses the accent");
  assert.match(frame[0], /\x1b\[38;2;24;24;37m/, "accent fills use panel_bg as text");
  assert.match(frame[frame.length - 1], /\x1b\[48;2;137;180;250m/, "primary chip uses the accent");
});

test("the cursor row is never painted in the accent colour", () => {
  const frame = ui.renderFrame(state({ theme: catppuccin }), { styled: true });
  const cursorRow = frame.find((l) => l.includes("Claude Code"));
  assert.ok(
    !cursorRow.includes("\x1b[48;2;137;180;250m"),
    "the accent is for tabs and chips; the selected row is a surface"
  );
});

test("a different theme yields different colours", () => {
  const solarized = { palette: themeLib.resolveTheme(configWith("solarized-light")).palette };
  const frame = ui.renderFrame(state({ theme: solarized }), { styled: true });
  const cursorRow = frame.find((l) => l.includes("Claude Code"));
  assert.match(cursorRow, /\x1b\[48;2;238;232;213m/, "solarized-light surface0");
  assert.ok(!cursorRow.includes("48;2;49;50;68"), "must not fall back to catppuccin");
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
