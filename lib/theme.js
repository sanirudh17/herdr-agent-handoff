"use strict";

const fs = require("node:fs");

// Herdr's UI colours come from its own palettes, not the terminal's ANSI palette,
// so an ANSI index only ever approximates them. These tables are transcribed from
// `Palette` in Herdr's src/app/state.rs (the `from_name` aliases included), which
// is what the settings modal itself renders with. That makes the picker match the
// user's theme exactly rather than nearly.
//
// Regenerate with scripts/extract-palettes.js against a Herdr checkout when the
// upstream palettes change.
const PALETTES = {
  catppuccin: { accent: [137, 180, 250], panel_bg: [24, 24, 37], surface0: [49, 50, 68], surface_dim: [30, 30, 46], overlay0: [108, 112, 134], overlay1: [127, 132, 156], text: [205, 214, 244], subtext0: [166, 173, 200] },
  catppuccin_latte: { accent: [30, 102, 245], panel_bg: [239, 241, 245], surface0: [204, 208, 218], surface_dim: [230, 233, 239], overlay0: [156, 160, 176], overlay1: [140, 143, 161], text: [76, 79, 105], subtext0: [108, 111, 133] },
  terminal: { accent: "Blue", panel_bg: "Reset", surface0: "Reset", surface_dim: "DarkGray", overlay0: "Gray", overlay1: "White", text: "Reset", subtext0: "Gray" },
  tokyo_night: { accent: [122, 162, 247], panel_bg: [26, 27, 38], surface0: [36, 40, 59], surface_dim: [26, 27, 38], overlay0: [86, 95, 137], overlay1: [105, 113, 150], text: [192, 202, 245], subtext0: [169, 177, 214] },
  tokyo_night_day: { accent: [46, 125, 233], panel_bg: [225, 226, 231], surface0: [196, 200, 218], surface_dim: [210, 211, 218], overlay0: [137, 144, 179], overlay1: [104, 112, 154], text: [55, 96, 191], subtext0: [97, 114, 176] },
  dracula: { accent: [189, 147, 249], panel_bg: [40, 42, 54], surface0: [68, 71, 90], surface_dim: [40, 42, 54], overlay0: [98, 114, 164], overlay1: [130, 140, 180], text: [248, 248, 242], subtext0: [210, 210, 220] },
  nord: { accent: [136, 192, 208], panel_bg: [46, 52, 64], surface0: [59, 66, 82], surface_dim: [46, 52, 64], overlay0: [76, 86, 106], overlay1: [100, 110, 130], text: [236, 239, 244], subtext0: [216, 222, 233] },
  gruvbox: { accent: [215, 153, 33], panel_bg: [40, 40, 40], surface0: [60, 56, 54], surface_dim: [40, 40, 40], overlay0: [146, 131, 116], overlay1: [168, 153, 132], text: [235, 219, 178], subtext0: [213, 196, 161] },
  gruvbox_light: { accent: [7, 102, 120], panel_bg: [251, 241, 199], surface0: [235, 219, 178], surface_dim: [242, 229, 188], overlay0: [146, 131, 116], overlay1: [124, 111, 100], text: [60, 56, 54], subtext0: [80, 73, 69] },
  one_dark: { accent: [97, 175, 239], panel_bg: [40, 44, 52], surface0: [44, 49, 58], surface_dim: [40, 44, 52], overlay0: [92, 99, 112], overlay1: [115, 122, 135], text: [171, 178, 191], subtext0: [150, 156, 168] },
  one_light: { accent: [64, 120, 242], panel_bg: [250, 250, 250], surface0: [240, 240, 241], surface_dim: [245, 245, 246], overlay0: [160, 161, 167], overlay1: [104, 107, 119], text: [56, 58, 66], subtext0: [104, 107, 119] },
  solarized: { accent: [38, 139, 210], panel_bg: [0, 43, 54], surface0: [7, 54, 66], surface_dim: [0, 43, 54], overlay0: [88, 110, 117], overlay1: [101, 123, 131], text: [147, 161, 161], subtext0: [131, 148, 150] },
  solarized_light: { accent: [38, 139, 210], panel_bg: [253, 246, 227], surface0: [238, 232, 213], surface_dim: [238, 232, 213], overlay0: [147, 161, 161], overlay1: [88, 110, 117], text: [101, 123, 131], subtext0: [131, 148, 150] },
  kanagawa: { accent: [126, 156, 216], panel_bg: [31, 31, 40], surface0: [42, 42, 55], surface_dim: [31, 31, 40], overlay0: [114, 113, 105], overlay1: [135, 134, 125], text: [220, 215, 186], subtext0: [200, 195, 170] },
  kanagawa_lotus: { accent: [77, 105, 155], panel_bg: [242, 236, 188], surface0: [220, 213, 172], surface_dim: [213, 206, 163], overlay0: [160, 156, 172], overlay1: [138, 137, 128], text: [84, 84, 100], subtext0: [67, 67, 108] },
  rose_pine: { accent: [196, 167, 231], panel_bg: [25, 23, 36], surface0: [31, 29, 46], surface_dim: [25, 23, 36], overlay0: [110, 106, 134], overlay1: [144, 140, 170], text: [224, 222, 244], subtext0: [200, 197, 220] },
  rose_pine_dawn: { accent: [144, 122, 169], panel_bg: [250, 244, 237], surface0: [242, 233, 225], surface_dim: [242, 233, 225], overlay0: [152, 147, 165], overlay1: [121, 117, 147], text: [70, 66, 97], subtext0: [121, 117, 147] },
  vesper: { accent: [255, 199, 153], panel_bg: [26, 26, 26], surface0: [35, 35, 35], surface_dim: [16, 16, 16], overlay0: [92, 92, 92], overlay1: [126, 126, 126], text: [255, 255, 255], subtext0: [160, 160, 160] },
};

const THEME_ALIASES = {
  "catppuccin": "catppuccin", "catppuccin-mocha": "catppuccin",
  "catppuccin-latte": "catppuccin_latte", "latte": "catppuccin_latte", "light": "catppuccin_latte",
  "terminal": "terminal",
  "tokyo-night": "tokyo_night", "tokyonight": "tokyo_night",
  "tokyo-night-day": "tokyo_night_day", "tokyo-day": "tokyo_night_day", "tokyonight-day": "tokyo_night_day",
  "dracula": "dracula",
  "nord": "nord",
  "gruvbox": "gruvbox", "gruvbox-dark": "gruvbox", "gruvbox-light": "gruvbox_light",
  "one-dark": "one_dark", "onedark": "one_dark", "one-light": "one_light", "onelight": "one_light",
  "solarized": "solarized", "solarized-dark": "solarized", "solarized-light": "solarized_light",
  "kanagawa": "kanagawa", "kanagawa-lotus": "kanagawa_lotus", "lotus": "kanagawa_lotus",
  "rose-pine": "rose_pine", "rosepine": "rose_pine",
  "rose-pine-dawn": "rose_pine_dawn", "rosepine-dawn": "rose_pine_dawn", "dawn": "rose_pine_dawn",
  "vesper": "vesper",
};

const DEFAULT_THEME = "catppuccin";

// Ratatui's named colours, for the "terminal" palette which defers to the host.
const NAMED_ANSI = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, gray: 7,
  grey: 7, white: 15, darkgray: 8, darkgrey: 8, lightred: 9, lightgreen: 10,
  lightyellow: 11, lightblue: 12, lightmagenta: 13, lightcyan: 14,
  brightblack: 8, brightred: 9, brightgreen: 10, brightyellow: 11,
  brightblue: 12, brightmagenta: 13, brightcyan: 14, brightwhite: 15,
};

function parseColor(value) {
  if (!value) return null;
  if (Array.isArray(value)) return { kind: "rgb", r: value[0], g: value[1], b: value[2] };

  const text = String(value).trim();
  if (/^reset$/i.test(text)) return { kind: "reset" };

  const hex6 = text.match(/^#([0-9a-fA-F]{6})$/);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return { kind: "rgb", r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const hex3 = text.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) {
    const [r, g, b] = hex3[1].split("").map((c) => parseInt(c + c, 16));
    return { kind: "rgb", r, g, b };
  }
  const rgb = text.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) return { kind: "rgb", r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };

  const named = NAMED_ANSI[text.toLowerCase().replace(/[\s_-]/g, "")];
  if (named !== undefined) return { kind: "index", index: named };

  return null;
}

const fg = (c) => {
  if (!c) return "";
  if (c.kind === "reset") return "\x1b[39m";
  if (c.kind === "rgb") return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
  return c.index < 8 ? `\x1b[${30 + c.index}m` : `\x1b[${90 + c.index - 8}m`;
};

const bg = (c) => {
  if (!c) return "";
  if (c.kind === "reset") return "\x1b[49m";
  if (c.kind === "rgb") return `\x1b[48;2;${c.r};${c.g};${c.b}m`;
  return c.index < 8 ? `\x1b[${40 + c.index}m` : `\x1b[${100 + c.index - 8}m`;
};

// Narrow config scan rather than a TOML parser: only a handful of keys matter and
// the plugin ships no dependencies.
function readSections(text) {
  const sections = {};
  let current = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1];
      sections[current] = sections[current] || {};
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!pair) continue;
    sections[current] = sections[current] || {};
    sections[current][pair[1]] = pair[2].replace(/^"(.*)"$/, "$1");
  }
  return sections;
}

function paletteFor(name) {
  const key = String(name || "").toLowerCase().replace(/[\s_]/g, "-");
  return PALETTES[THEME_ALIASES[key]] || null;
}

// `auto_switch` picks between dark_name and light_name from the host appearance,
// which a plugin cannot observe. `name` is the honest choice, and it is also what
// Herdr falls back to.
function resolveTheme(configPath) {
  const sections = readSections(readConfig(configPath));
  const themeSection = sections.theme || {};
  const base = paletteFor(themeSection.name) || PALETTES[DEFAULT_THEME];

  const palette = {
    accent: parseColor(base.accent),
    panelBg: parseColor(base.panel_bg),
    surface0: parseColor(base.surface0),
    surfaceDim: parseColor(base.surface_dim),
    overlay0: parseColor(base.overlay0),
    overlay1: parseColor(base.overlay1),
    text: parseColor(base.text),
    subtext0: parseColor(base.subtext0),
  };

  // [theme.custom] overrides the base palette, exactly as Herdr applies them.
  const custom = sections["theme.custom"] || {};
  const overrides = {
    accent: "accent", panel_bg: "panelBg", surface0: "surface0",
    surface_dim: "surfaceDim", overlay0: "overlay0", overlay1: "overlay1",
    text: "text", subtext0: "subtext0",
  };
  for (const [key, field] of Object.entries(overrides)) {
    const parsed = parseColor(custom[key]);
    if (parsed) palette[field] = parsed;
  }

  // A legacy [ui] accent still wins for the accent token.
  const uiAccent = parseColor((sections.ui || {}).accent);
  if (uiAccent) palette.accent = uiAccent;

  return { name: themeSection.name || DEFAULT_THEME, palette };
}

function readConfig(configPath) {
  if (!configPath) return null;
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

// Text placed on an accent fill. Herdr uses panel_contrast_fg(): the panel
// background, or surface_dim when the panel background defers to the terminal.
function contrastFg(palette) {
  if (!palette.panelBg || palette.panelBg.kind === "reset") return palette.surfaceDim;
  return palette.panelBg;
}

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// The same style recipe Herdr's settings modal uses, so the picker is
// indistinguishable from it. See src/ui/settings.rs.
function styles(theme) {
  const p = (theme && theme.palette) || resolveTheme(null).palette;
  const onAccent = fg(contrastFg(p)) + bg(p.accent) + BOLD;
  return {
    reset: RESET,
    base: fg(p.subtext0) + bg(p.panelBg),
    panelBg: bg(p.panelBg),
    activeTab: onAccent,
    // Pointer feedback. overlay0 is deliberately lighter than the cursor row's
    // surface0 and is not the accent, so hover, selection and the active tab are
    // three visibly different things. surface_dim is unusable here: in catppuccin
    // it is #1e1e2e against a #181825 panel, effectively invisible.
    activeTabHover: fg(contrastFg(p)) + bg(p.overlay1) + BOLD,
    hoverRow: fg(p.text) + bg(p.overlay0) + BOLD,
    inactiveTab: fg(p.overlay1) + bg(p.panelBg),
    cursorRow: fg(p.text) + bg(p.surface0) + BOLD,
    primaryChip: onAccent,
    secondaryChip: fg(p.text) + bg(p.surface0) + BOLD,
    dim: fg(p.overlay0) + bg(p.panelBg),
    muted: fg(p.subtext0) + bg(p.panelBg),
    accentText: fg(p.accent) + bg(p.panelBg) + BOLD,
  };
}

module.exports = {
  PALETTES, THEME_ALIASES, DEFAULT_THEME,
  parseColor, paletteFor, resolveTheme, styles, contrastFg, fg, bg, readSections,
};
