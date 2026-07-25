const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const theme = require("../lib/theme.js");

function configFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-theme-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, body);
  return file;
}

test("every theme Herdr offers in its settings modal is known", () => {
  // The list shown in Herdr's own theme section.
  for (const name of [
    "catppuccin", "catppuccin-latte", "terminal", "tokyo-night", "tokyo-night-day",
    "dracula", "nord", "gruvbox", "gruvbox-light", "one-dark", "one-light",
    "solarized", "solarized-light", "kanagawa", "kanagawa-lotus", "rose-pine",
    "rose-pine-dawn", "vesper",
  ]) {
    assert.ok(theme.paletteFor(name), `no palette for ${name}`);
  }
});

test("upstream aliases resolve to the same palette", () => {
  assert.deepEqual(theme.paletteFor("catppuccin-mocha"), theme.paletteFor("catppuccin"));
  assert.deepEqual(theme.paletteFor("tokyonight"), theme.paletteFor("tokyo-night"));
  assert.deepEqual(theme.paletteFor("solarized-dark"), theme.paletteFor("solarized"));
  assert.deepEqual(theme.paletteFor("dawn"), theme.paletteFor("rose-pine-dawn"));
  assert.deepEqual(theme.paletteFor("Tokyo Night"), theme.paletteFor("tokyo-night"));
});

test("unknown themes have no palette", () => {
  assert.equal(theme.paletteFor("mauve-dream"), null);
  assert.equal(theme.paletteFor(""), null);
});

test("each palette carries every token the picker styles with", () => {
  for (const [name, palette] of Object.entries(theme.PALETTES)) {
    for (const token of ["accent", "panel_bg", "surface0", "surface_dim", "overlay0", "overlay1", "text", "subtext0"]) {
      assert.ok(palette[token], `${name} is missing ${token}`);
    }
  }
});

test("catppuccin resolves to Herdr's own values", () => {
  const { palette } = theme.resolveTheme(configFile('[theme]\nname = "catppuccin"\n'));
  assert.deepEqual(palette.accent, { kind: "rgb", r: 137, g: 180, b: 250 });
  assert.deepEqual(palette.surface0, { kind: "rgb", r: 49, g: 50, b: 68 });
  assert.deepEqual(palette.panelBg, { kind: "rgb", r: 24, g: 24, b: 37 });
});

test("solarized-light resolves to its own values, not catppuccin's", () => {
  const { palette } = theme.resolveTheme(configFile('[theme]\nname = "solarized-light"\n'));
  assert.deepEqual(palette.accent, { kind: "rgb", r: 38, g: 139, b: 210 });
  assert.deepEqual(palette.panelBg, { kind: "rgb", r: 253, g: 246, b: 227 });
});

test("a missing or unreadable config falls back to the default theme", () => {
  assert.equal(theme.resolveTheme(null).name, theme.DEFAULT_THEME);
  assert.equal(theme.resolveTheme("/no/such/config.toml").name, theme.DEFAULT_THEME);
});

test("an unknown theme name falls back to the default palette", () => {
  const { palette } = theme.resolveTheme(configFile('[theme]\nname = "not-a-theme"\n'));
  assert.deepEqual(palette.accent, { kind: "rgb", r: 137, g: 180, b: 250 });
});

test("[theme.custom] overrides the base palette", () => {
  const { palette } = theme.resolveTheme(
    configFile('[theme]\nname = "nord"\n\n[theme.custom]\naccent = "#ff0000"\nsurface0 = "rgb(1,2,3)"\n')
  );
  assert.deepEqual(palette.accent, { kind: "rgb", r: 255, g: 0, b: 0 });
  assert.deepEqual(palette.surface0, { kind: "rgb", r: 1, g: 2, b: 3 });
  // untouched tokens keep nord's values
  assert.deepEqual(palette.text, { kind: "rgb", r: 236, g: 239, b: 244 });
});

test("a legacy [ui] accent still wins", () => {
  const { palette } = theme.resolveTheme(configFile('[theme]\nname = "nord"\n\n[ui]\naccent = "magenta"\n'));
  assert.deepEqual(palette.accent, { kind: "index", index: 5 });
});

test("commented-out settings are ignored", () => {
  const { palette } = theme.resolveTheme(configFile('[theme]\n# name = "dracula"\n'));
  assert.deepEqual(palette.accent, { kind: "rgb", r: 137, g: 180, b: 250 });
});

test("the terminal theme defers to the host palette", () => {
  const { palette } = theme.resolveTheme(configFile('[theme]\nname = "terminal"\n'));
  assert.deepEqual(palette.accent, { kind: "index", index: 4 });
  assert.deepEqual(palette.panelBg, { kind: "reset" });
  assert.deepEqual(palette.text, { kind: "reset" });
});

test("accent fills use the panel background as their foreground, as Herdr does", () => {
  const nord = theme.resolveTheme(configFile('[theme]\nname = "nord"\n'));
  assert.deepEqual(theme.contrastFg(nord.palette), nord.palette.panelBg);

  // With a Reset panel background there is nothing to contrast against, so Herdr
  // falls back to surface_dim.
  const term = theme.resolveTheme(configFile('[theme]\nname = "terminal"\n'));
  assert.deepEqual(theme.contrastFg(term.palette), term.palette.surfaceDim);
});

test("styles emit truecolour SGR built from the resolved palette", () => {
  const s = theme.styles(theme.resolveTheme(configFile('[theme]\nname = "catppuccin"\n')));
  assert.match(s.activeTab, /\x1b\[48;2;137;180;250m/, "active tab sits on the accent");
  assert.match(s.activeTab, /\x1b\[38;2;24;24;37m/, "with the panel background as text");
  // The focused row carries the accent, so the selection reads as one solid block.
  assert.match(s.cursorRow, /\x1b\[48;2;137;180;250m/, "cursor row uses the accent");
  assert.match(s.hoverRow, /\x1b\[48;2;49;50;68m/, "the pointer gets the quieter surface");
  assert.match(s.primaryChip, /\x1b\[48;2;137;180;250m/);
  assert.match(s.secondaryChip, /\x1b\[48;2;49;50;68m/);
});

test("every theme paints the focused row in its own accent", () => {
  for (const name of Object.keys(theme.THEME_ALIASES)) {
    const resolved = theme.resolveTheme(configFile(`[theme]\nname = "${name}"\n`));
    const s = theme.styles(resolved);
    const accentBg = theme.bg(resolved.palette.accent);
    assert.ok(
      s.cursorRow.includes(accentBg),
      `${name}: the focused row should be filled with the theme's accent`
    );
    assert.ok(
      !s.hoverRow.includes(accentBg),
      `${name}: hover must stay distinguishable from the selection`
    );
  }
});

test("every theme produces a complete, distinct style set", () => {
  const seen = new Set();
  for (const name of Object.keys(theme.PALETTES)) {
    const s = theme.styles({ palette: theme.resolveTheme(null).palette });
    for (const key of ["activeTab", "cursorRow", "primaryChip", "secondaryChip", "dim", "base"]) {
      assert.ok(s[key] && s[key].length > 0, `${name} produced no ${key}`);
    }
    seen.add(name);
  }
  assert.equal(seen.size, 18);
});
