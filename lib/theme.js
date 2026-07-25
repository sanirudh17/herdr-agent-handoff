"use strict";

const fs = require("node:fs");

// Herdr renders pane output through the palette of the user's chosen theme, so an
// ANSI palette index is automatically the theme's colour: index 4 is catppuccin's
// blue under catppuccin, nord's blue under nord, and so on. Reverse video, by
// contrast, always produced the same white bar regardless of theme.
//
// An explicit `accent` in config.toml wins, because the user has said what they
// want. Named colours map to palette indices (still theme-mapped); hex and rgb()
// are emitted as truecolour since no index can represent them.
const NAMED_INDEX = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  gray: 8, grey: 8, brightblack: 8, brightred: 9, brightgreen: 10,
  brightyellow: 11, brightblue: 12, brightmagenta: 13, brightcyan: 14,
  brightwhite: 15,
};

const DEFAULT_INDEX = 4; // the theme's blue, matching Herdr's own popup border

function parseAccent(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();

  const hex = text.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { kind: "rgb", r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  const short = text.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => parseInt(c + c, 16));
    return { kind: "rgb", r, g, b };
  }

  const rgb = text.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) {
    return { kind: "rgb", r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }

  const named = NAMED_INDEX[text.replace(/[\s_-]/g, "")];
  if (named !== undefined) return { kind: "index", index: named };

  return null;
}

// Reads `accent` from the [ui] section, then [theme.custom]. Deliberately a
// narrow scan rather than a TOML parser: only these two keys matter, and the
// plugin ships no dependencies.
function accentFromConfig(text) {
  if (!text) return null;
  let section = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== "ui" && section !== "theme.custom") continue;
    const match = line.match(/^accent\s*=\s*"([^"]*)"/);
    if (match) {
      const parsed = parseAccent(match[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function readConfig(configPath) {
  if (!configPath) return null;
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

function resolveAccent(configPath) {
  return accentFromConfig(readConfig(configPath)) || { kind: "index", index: DEFAULT_INDEX };
}

// SGR fragments for the resolved accent, as foreground and as background.
function accentCodes(accent) {
  const value = accent && accent.kind ? accent : { kind: "index", index: DEFAULT_INDEX };
  if (value.kind === "rgb") {
    return {
      fg: `\x1b[38;2;${value.r};${value.g};${value.b}m`,
      bg: `\x1b[48;2;${value.r};${value.g};${value.b}m`,
    };
  }
  const index = value.index;
  return {
    fg: index < 8 ? `\x1b[${30 + index}m` : `\x1b[${90 + index - 8}m`,
    bg: index < 8 ? `\x1b[${40 + index}m` : `\x1b[${100 + index - 8}m`,
  };
}

module.exports = { parseAccent, accentFromConfig, resolveAccent, accentCodes, DEFAULT_INDEX };
