"use strict";

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

function decodeInput(buffer) {
  const events = [];
  let i = 0;
  const text = buffer.toString("binary");

  while (i < text.length) {
    const rest = text.slice(i);

    const mouse = rest.match(SGR_MOUSE);
    if (mouse) {
      i += mouse[0].length;
      if (mouse[4] === "M") {
        events.push({
          type: "mouse",
          button: Number(mouse[1]),
          col: Number(mouse[2]) - 1,
          row: Number(mouse[3]) - 1,
        });
      }
      continue;
    }

    if (rest.startsWith("\x1b[A")) { events.push({ type: "key", name: "up" }); i += 3; continue; }
    if (rest.startsWith("\x1b[B")) { events.push({ type: "key", name: "down" }); i += 3; continue; }
    if (rest.startsWith("\x1b[C")) { events.push({ type: "key", name: "right" }); i += 3; continue; }
    if (rest.startsWith("\x1b[D")) { events.push({ type: "key", name: "left" }); i += 3; continue; }

    const ch = text[i];
    i += 1;

    if (ch === "\x1b") { events.push({ type: "key", name: "escape" }); continue; }
    if (ch === "\r" || ch === "\n") { events.push({ type: "key", name: "enter" }); continue; }
    if (ch === "\x03") { events.push({ type: "key", name: "ctrl-c" }); continue; }
    if (ch === "\x7f") { events.push({ type: "key", name: "backspace" }); continue; }
    if (ch >= " " && ch <= "~") { events.push({ type: "key", name: ch }); continue; }
  }

  return events;
}

function initialState(opts) {
  const {
    title, contextLine, available, unavailable = [], unavailableCount = 0,
    width = 78, height = 20,
  } = opts;
  return {
    title, contextLine, available, unavailable, unavailableCount,
    width, height, cursor: 0, scrollTop: 0, showUnavailable: false,
  };
}

// Rows above the agent list: title, blank, context, blank.
const HEADER_ROWS = 4;
// Rows below: blank, hint line, blank, footer.
const FOOTER_ROWS = 4;
const MAX_UNAVAILABLE_SHOWN = 6;

function viewportSize(state) {
  const extra = state.showUnavailable
    ? Math.min(state.unavailable.length, MAX_UNAVAILABLE_SHOWN) + 1
    : 0;
  return Math.max(1, state.height - HEADER_ROWS - FOOTER_ROWS - extra);
}

function clampScroll(state) {
  const size = viewportSize(state);
  let scrollTop = state.scrollTop;
  if (state.cursor < scrollTop) scrollTop = state.cursor;
  if (state.cursor >= scrollTop + size) scrollTop = state.cursor - size + 1;
  scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, state.available.length - size)));
  return { ...state, scrollTop };
}

function applyKey(state, key) {
  const last = state.available.length - 1;

  if (key === "escape" || key === "q" || key === "ctrl-c") {
    return { state, action: { cancel: true } };
  }

  if (key === "up" || key === "k") {
    return { state: clampScroll({ ...state, cursor: Math.max(0, state.cursor - 1) }), action: null };
  }

  if (key === "down" || key === "j") {
    return { state: clampScroll({ ...state, cursor: Math.min(last, state.cursor + 1) }), action: null };
  }

  if (key === "enter") {
    const chosen = state.available[state.cursor];
    return { state, action: chosen ? { select: chosen.kind } : null };
  }

  if (key === "?") {
    return { state: clampScroll({ ...state, showUnavailable: !state.showUnavailable }), action: null };
  }

  if (key >= "1" && key <= "9") {
    const index = Number(key) - 1;
    const chosen = state.available[index];
    return { state, action: chosen ? { select: chosen.kind } : null };
  }

  return { state, action: null };
}

// Maps a rendered row number back to an index into state.available. Only rows
// holding a selectable agent appear here, so clicks anywhere else are inert.
function agentRowIndex(state) {
  const map = new Map();
  const size = viewportSize(state);
  const visible = state.available.slice(state.scrollTop, state.scrollTop + size);
  visible.forEach((_, offset) => {
    map.set(HEADER_ROWS + offset, state.scrollTop + offset);
  });
  return map;
}

function applyClick(state, row) {
  const index = agentRowIndex(state).get(row);
  if (index === undefined) return { state, action: null };
  const chosen = state.available[index];
  if (!chosen) return { state, action: null };
  return { state: { ...state, cursor: index }, action: { select: chosen.kind } };
}

function pad(text, width) {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function renderFrame(state) {
  const total = state.available.length + state.unavailableCount;
  const counter = `${state.available.length} / ${total} available`;
  const lines = [];

  lines.push(pad(state.title, Math.max(0, state.width - counter.length)) + counter);
  lines.push("");
  lines.push(state.contextLine);
  lines.push("");

  const size = viewportSize(state);
  const visible = state.available.slice(state.scrollTop, state.scrollTop + size);
  for (const [offset, agent] of visible.entries()) {
    const index = state.scrollTop + offset;
    const marker = index === state.cursor ? "▸" : " ";
    const note = agent.isSource ? "same agent, fresh session" : "";
    lines.push(`  ${marker} ${pad(agent.name, 30)}${pad(agent.kind, 14)}${note}`.trimEnd());
  }

  lines.push("");

  if (state.showUnavailable) {
    lines.push("  not installed:");
    for (const agent of state.unavailable.slice(0, MAX_UNAVAILABLE_SHOWN)) {
      lines.push(`      ${pad(agent.name, 30)}${agent.kind}`.trimEnd());
    }
  } else if (state.unavailableCount > 0) {
    lines.push(`  ${state.unavailableCount} more supported agents not installed · ? to show`);
  } else {
    lines.push("");
  }

  lines.push("");
  lines.push("  ↑↓ move · 1-9 jump · enter select · esc cancel");

  return lines.slice(0, state.height);
}

module.exports = { decodeInput, initialState, applyKey, applyClick, renderFrame, viewportSize };
