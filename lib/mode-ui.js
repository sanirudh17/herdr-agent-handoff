"use strict";

const { styles: themeStyles } = require("./theme.js");

const RESET = "\x1b[0m";

const MODES = [
  {
    id: "focused",
    label: "Focused handoff",
    hint: "Concise summary — recommended",
  },
  {
    id: "full",
    label: "Full session transcript",
    hint: "Complete history",
  },
];

function tokens(state) {
  return themeStyles(state.theme);
}

function truncate(text, width) {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return text.slice(0, width - 1) + "…";
}

function pad(text, width) {
  return text.length >= width
    ? truncate(text, width)
    : text + " ".repeat(width - text.length);
}

function style(text, codes, styled) {
  if (!styled || !codes) return text;
  return codes + text + RESET;
}

function initialState(opts = {}) {
  const { contextLine = "", width = 78, height = 20, theme = null } = opts;
  return {
    contextLine,
    theme,
    cursor: 0,
    chosen: null,
    hover: null,
    width,
    height,
  };
}

const HEADER_ROWS = 4;
const FOOTER_ROWS = 2;

function move(state, delta) {
  const last = MODES.length - 1;
  const next = Math.max(0, Math.min(last, state.cursor + delta));
  if (next === state.cursor) return state;
  return { ...state, cursor: next };
}

function applyKey(state, key) {
  if (key === "escape" || key === "q" || key === "ctrl-c") {
    return { state, action: { cancel: true } };
  }
  if (key === "up" || key === "k")
    return { state: move(state, -1), action: null };
  if (key === "down" || key === "j")
    return { state: move(state, 1), action: null };
  if (key === "tab") return { state: move(state, 1), action: null };
  if (key === "shift-tab") return { state: move(state, -1), action: null };
  if (key === "enter") {
    const mode = MODES[state.cursor];
    if (!mode) return { state, action: null };
    return {
      state: { ...state, chosen: mode.id },
      action: { mode: mode.id },
    };
  }
  if (key === "1" || key === "2") {
    const mode = MODES[Number(key) - 1];
    if (!mode) return { state, action: null };
    return {
      state: { ...state, cursor: Number(key) - 1, chosen: mode.id },
      action: { mode: mode.id },
    };
  }
  return { state, action: null };
}

function listRowIndex() {
  const map = new Map();
  MODES.forEach((_, index) => {
    map.set(HEADER_ROWS + index, index);
  });
  return map;
}

function sameHover(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.index === b.index;
}

function applyHover(state, row) {
  const index = listRowIndex().get(row);
  const hover = index === undefined ? null : { kind: "row", index };
  return sameHover(state.hover, hover) ? state : { ...state, hover };
}

function applyClick(state, row) {
  const index = listRowIndex().get(row);
  if (index === undefined) return { state, action: null };
  const mode = MODES[index];
  if (!mode) return { state, action: null };
  return {
    state: { ...state, cursor: index, chosen: mode.id },
    action: { mode: mode.id },
  };
}

function footerLine(state, width, styled) {
  const t = tokens(state);
  const hint = "  ↑↓ select · 1-2 jump";
  const chips = [
    { label: " ⏎ select ", primary: true },
    { label: " esc cancel ", primary: false },
  ];
  const short = [
    { label: " ⏎ ", primary: true },
    { label: " esc ", primary: false },
  ];
  const render = (list) =>
    list
      .map((c) =>
        style(c.label, c.primary ? t.primaryChip : t.secondaryChip, styled),
      )
      .join(" ");
  const plainOf = (list) => list.map((c) => c.label).join(" ");
  if (hint.length + plainOf(chips).length + 1 <= width) {
    const gap = width - hint.length - plainOf(chips).length;
    return (
      style(hint, t.dim, styled) + " ".repeat(Math.max(1, gap)) + render(chips)
    );
  }
  if (plainOf(chips).length + 1 <= width) {
    return (
      " ".repeat(Math.max(1, width - plainOf(chips).length)) + render(chips)
    );
  }
  if (plainOf(short).length + 1 <= width) {
    return (
      " ".repeat(Math.max(1, width - plainOf(short).length)) + render(short)
    );
  }
  return truncate(hint, width);
}

function renderFrame(state, opts = {}) {
  const { styled = false } = opts;
  const width = Math.max(24, state.width);
  const lines = [];
  const t = tokens(state);

  lines.push(
    style(truncate("  Choose handoff context", width), t.muted, styled),
  );
  lines.push("");
  lines.push(
    style(truncate(` ${state.contextLine || ""}`, width), t.muted, styled),
  );
  lines.push("");

  MODES.forEach((mode, index) => {
    const isCursor = index === state.cursor;
    const marker = isCursor ? "▸" : " ";
    const label = index === 0 ? `${mode.label} (default)` : mode.label;
    const rowText = `  ${marker} ${label} — ${mode.hint}`;
    const row = pad(truncate(rowText, width), width);
    const hovered =
      state.hover && state.hover.kind === "row" && state.hover.index === index;
    if (isCursor) {
      lines.push(style(row, t.cursorRow, styled));
    } else if (hovered) {
      lines.push(style(row, t.hoverRow, styled));
    } else {
      lines.push(style(row, t.muted, styled));
    }
  });

  const size = Math.max(1, state.height - HEADER_ROWS - FOOTER_ROWS);
  for (let i = MODES.length; i < size; i += 1) lines.push("");

  lines.push("");
  lines.push(footerLine(state, width, styled));

  return lines.slice(0, state.height);
}

function renderChosenFrame(state, opts = {}) {
  const frame = renderFrame(state, opts);
  const mode = MODES.find((m) => m.id === state.chosen);
  const name = mode ? mode.label : state.chosen;
  const message = `  ✓ ${name}…`;
  frame[frame.length - 1] = style(
    truncate(message, state.width),
    tokens(state).accentText,
    opts.styled || false,
  );
  return frame;
}

module.exports = {
  MODES,
  initialState,
  applyKey,
  applyClick,
  applyHover,
  renderFrame,
  renderChosenFrame,
};
