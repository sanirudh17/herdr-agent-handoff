const test = require("node:test");
const assert = require("node:assert/strict");
const theme = require("../lib/theme.js");

test("named colours become palette indices so the theme maps them", () => {
  assert.deepEqual(theme.parseAccent("blue"), { kind: "index", index: 4 });
  assert.deepEqual(theme.parseAccent("cyan"), { kind: "index", index: 6 });
  assert.deepEqual(theme.parseAccent("bright blue"), { kind: "index", index: 12 });
  assert.deepEqual(theme.parseAccent("MAGENTA"), { kind: "index", index: 5 });
});

test("hex and rgb accents become truecolour", () => {
  assert.deepEqual(theme.parseAccent("#89b4fa"), { kind: "rgb", r: 137, g: 180, b: 250 });
  assert.deepEqual(theme.parseAccent("#abc"), { kind: "rgb", r: 170, g: 187, b: 204 });
  assert.deepEqual(theme.parseAccent("rgb(1, 2, 3)"), { kind: "rgb", r: 1, g: 2, b: 3 });
});

test("nonsense accents are rejected", () => {
  assert.equal(theme.parseAccent("mauve-ish"), null);
  assert.equal(theme.parseAccent(""), null);
  assert.equal(theme.parseAccent(undefined), null);
});

test("accent is read from the [ui] section", () => {
  const config = ['[theme]', 'name = "catppuccin"', '', '[ui]', 'accent = "magenta"'].join("\n");
  assert.deepEqual(theme.accentFromConfig(config), { kind: "index", index: 5 });
});

test("accent is read from [theme.custom] too", () => {
  const config = ['[theme.custom]', 'accent = "#89b4fa"'].join("\n");
  assert.deepEqual(theme.accentFromConfig(config), { kind: "rgb", r: 137, g: 180, b: 250 });
});

test("commented-out accents are ignored", () => {
  const config = ['[ui]', '# accent = "red"'].join("\n");
  assert.equal(theme.accentFromConfig(config), null);
});

test("an accent outside [ui] and [theme.custom] is ignored", () => {
  const config = ['[ui.toast]', 'accent = "red"'].join("\n");
  assert.equal(theme.accentFromConfig(config), null);
});

test("with no accent configured the theme's blue slot is used", () => {
  const config = ['[theme]', 'name = "catppuccin"'].join("\n");
  assert.equal(theme.accentFromConfig(config), null);
  assert.deepEqual(theme.resolveAccent(null), { kind: "index", index: theme.DEFAULT_INDEX });
  assert.equal(theme.DEFAULT_INDEX, 4);
});

test("palette indices produce standard SGR colours, not reverse video", () => {
  const codes = theme.accentCodes({ kind: "index", index: 4 });
  assert.equal(codes.fg, "\x1b[34m");
  assert.equal(codes.bg, "\x1b[44m");
  const bright = theme.accentCodes({ kind: "index", index: 12 });
  assert.equal(bright.fg, "\x1b[94m");
  assert.equal(bright.bg, "\x1b[104m");
});

test("truecolour accents produce 24-bit SGR", () => {
  const codes = theme.accentCodes({ kind: "rgb", r: 137, g: 180, b: 250 });
  assert.equal(codes.bg, "\x1b[48;2;137;180;250m");
});

test("a missing accent still yields usable codes", () => {
  const codes = theme.accentCodes(undefined);
  assert.equal(codes.bg, "\x1b[44m");
});
