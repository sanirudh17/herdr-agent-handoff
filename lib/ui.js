"use strict";

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

const { styles: themeStyles } = require("./theme.js");

const RESET = "\x1b[0m";

const SECTIONS = ["installed", "notInstalled"];

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
        const button = Number(mouse[1]);
        events.push({
          // Bit 5 (32) marks motion; without it this is a press.
          type: (button & 32) !== 0 ? "hover" : "mouse",
          button,
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
    if (rest.startsWith("\x1b[5~")) { events.push({ type: "key", name: "pageup" }); i += 4; continue; }
    if (rest.startsWith("\x1b[6~")) { events.push({ type: "key", name: "pagedown" }); i += 4; continue; }
    if (rest.startsWith("\x1b[Z")) { events.push({ type: "key", name: "shift-tab" }); i += 3; continue; }

    const ch = text[i];
    i += 1;

    if (ch === "\x1b") { events.push({ type: "key", name: "escape" }); continue; }
    if (ch === "\r" || ch === "\n") { events.push({ type: "key", name: "enter" }); continue; }
    if (ch === "\t") { events.push({ type: "key", name: "tab" }); continue; }
    if (ch === "\x03") { events.push({ type: "key", name: "ctrl-c" }); continue; }
    if (ch === "\x7f") { events.push({ type: "key", name: "backspace" }); continue; }
    if (ch >= " " && ch <= "~") { events.push({ type: "key", name: ch }); continue; }
  }

  return events;
}

function initialState(opts) {
  const {
    contextLine, destination, installed, notInstalled = [], width = 78, height = 20,
    theme = null,
  } = opts;
  return {
    contextLine,
    destination,
    installed,
    notInstalled,
    theme,
    section: "installed",
    cursor: 0,
    scroll: { installed: 0, notInstalled: 0 },
    chosen: null,
    hover: null,
    width,
    height,
  };
}

// Rows above the list: tabs, blank, context, blank.
const HEADER_ROWS = 4;
// Rows below the list: blank, footer.
const FOOTER_ROWS = 2;

function items(state, section = state.section) {
  return section === "installed" ? state.installed : state.notInstalled;
}

function viewportSize(state) {
  return Math.max(1, state.height - HEADER_ROWS - FOOTER_ROWS);
}

function clampScroll(state) {
  const size = viewportSize(state);
  const list = items(state);
  const cursor = state.section === "installed" ? state.cursor : state.scroll.notInstalled;
  let top = state.scroll[state.section];
  if (cursor < top) top = cursor;
  if (cursor >= top + size) top = cursor - size + 1;
  top = Math.max(0, Math.min(top, Math.max(0, list.length - size)));
  return { ...state, scroll: { ...state.scroll, [state.section]: top } };
}

function move(state, delta) {
  const list = items(state);
  if (list.length === 0) return state;
  const last = list.length - 1;
  if (state.section === "installed") {
    const cursor = Math.max(0, Math.min(last, state.cursor + delta));
    return clampScroll({ ...state, cursor });
  }
  // The not-installed section is a reference list: nothing there is selectable,
  // so the keys scroll it rather than moving a cursor.
  const top = Math.max(0, Math.min(last, state.scroll.notInstalled + delta));
  return clampScroll({ ...state, scroll: { ...state.scroll, notInstalled: top } });
}

function switchSection(state, delta) {
  if (state.notInstalled.length === 0) return state;
  const index = SECTIONS.indexOf(state.section);
  const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length];
  return clampScroll({ ...state, section: next });
}

function applyKey(state, key) {
  if (key === "escape" || key === "q" || key === "ctrl-c") {
    return { state, action: { cancel: true } };
  }

  if (key === "up" || key === "k") return { state: move(state, -1), action: null };
  if (key === "down" || key === "j") return { state: move(state, 1), action: null };
  if (key === "pageup") return { state: move(state, -viewportSize(state)), action: null };
  if (key === "pagedown") return { state: move(state, viewportSize(state)), action: null };
  // Left/right move between sections, the way the tab row reads.
  if (key === "tab" || key === "right" || key === "l") {
    return { state: switchSection(state, 1), action: null };
  }
  if (key === "shift-tab" || key === "left" || key === "h") {
    return { state: switchSection(state, -1), action: null };
  }

  if (key === "?") {
    const target = state.section === "installed" ? "notInstalled" : "installed";
    if (target === "notInstalled" && state.notInstalled.length === 0) return { state, action: null };
    return { state: clampScroll({ ...state, section: target }), action: null };
  }

  if (key === "enter") {
    if (state.section !== "installed") return { state, action: null };
    const chosen = state.installed[state.cursor];
    if (!chosen) return { state, action: null };
    return { state: { ...state, chosen: chosen.kind }, action: { select: chosen.kind } };
  }

  if (key >= "1" && key <= "9") {
    if (state.section !== "installed") return { state, action: null };
    const chosen = state.installed[Number(key) - 1];
    if (!chosen) return { state, action: null };
    return {
      state: { ...state, cursor: Number(key) - 1, chosen: chosen.kind },
      action: { select: chosen.kind },
    };
  }

  return { state, action: null };
}

// Rendered row -> index in the current section's list. Used for hover in both
// sections.
function listRowIndex(state) {
  const map = new Map();
  const size = viewportSize(state);
  const top = state.scroll[state.section];
  items(state).slice(top, top + size).forEach((_, offset) => {
    map.set(HEADER_ROWS + offset, top + offset);
  });
  return map;
}

// Rendered row -> index in the installed list. Only rows holding a selectable
// agent appear, so clicks anywhere else are inert.
function agentRowIndex(state) {
  if (state.section !== "installed") return new Map();
  return listRowIndex(state);
}

// Whatever the pointer is over, so it can be highlighted. Tabs and rows only;
// anywhere else clears the highlight.
function applyHover(state, row, col) {
  const total = state.installed.length + state.notInstalled.length;
  if (row === 0 && typeof col === "number") {
    const hit = headerTabs(state, Math.max(24, state.width), total).labels
      .find((l) => col >= l.start && col < l.end);
    const hover = hit ? { kind: "tab", key: hit.key } : null;
    return sameHover(state.hover, hover) ? state : { ...state, hover };
  }

  const index = listRowIndex(state).get(row);
  const hover = index === undefined
    ? null
    : { kind: "row", section: state.section, index };
  return sameHover(state.hover, hover) ? state : { ...state, hover };
}

function sameHover(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.key === b.key && a.index === b.index && a.section === b.section;
}

function applyClick(state, row, col) {
  // Row 0 is the tab strip: clicking a label switches to that section.
  if (row === 0 && typeof col === "number") {
    const total = state.installed.length + state.notInstalled.length;
    const hit = headerTabs(state, Math.max(24, state.width), total).labels
      .find((l) => col >= l.start && col < l.end);
    if (hit && hit.key !== state.section) {
      return { state: clampScroll({ ...state, section: hit.key }), action: null };
    }
    return { state, action: null };
  }

  const index = agentRowIndex(state).get(row);
  if (index === undefined) return { state, action: null };
  const chosen = state.installed[index];
  if (!chosen) return { state, action: null };
  return {
    state: { ...state, cursor: index, chosen: chosen.kind },
    action: { select: chosen.kind },
  };
}

function truncate(text, width) {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return text.slice(0, width - 1) + "…";
}

function pad(text, width) {
  return text.length >= width ? truncate(text, width) : text + " ".repeat(width - text.length);
}

function style(text, codes, styled) {
  if (!styled || !codes) return text;
  return codes + text + RESET;
}

const SOURCE_TAG = "fresh session";
const NAME_CAP = 30;
const KIND_CAP = 14;
const PREFIX_WIDTH = 4; // "  ▸ "
const COL_GAP = 2;

// Columns hug their content rather than stretching to the pane edge — stretching
// flung the identifier to the far right and left the source tag floating in the
// middle of the row. Widths shrink (name first) when the pane is too narrow.
function columnWidths(list, width) {
  const longest = (pick, cap) => Math.min(cap, Math.max(4, ...list.map((a) => pick(a).length)));
  let nameWidth = list.length ? longest((a) => a.name, NAME_CAP) : 4;
  const kindWidth = list.length ? longest((a) => a.kind, KIND_CAP) : 4;
  const tagRoom = list.some((a) => a.isSource) ? COL_GAP + SOURCE_TAG.length : 0;
  const fixed = PREFIX_WIDTH + COL_GAP + kindWidth;

  // Give up the tag before squeezing the names into uselessness.
  let showTag = tagRoom > 0;
  if (fixed + nameWidth + tagRoom > width) showTag = false;
  const budget = width - fixed - (showTag ? tagRoom : 0);
  if (nameWidth > budget) nameWidth = Math.max(1, budget);

  return { nameWidth, kindWidth, showTag };
}

function agentRow(agent, { marker, width, nameWidth, kindWidth, showTag }) {
  const gap = " ".repeat(COL_GAP);
  const tag = showTag && agent.isSource ? gap + SOURCE_TAG : "";
  const row = `  ${marker} ` + pad(agent.name, nameWidth) + gap + pad(agent.kind, kindWidth) + tag;
  return truncate(row.replace(/\s+$/, ""), width);
}

// Both chrome rows degrade instead of overflowing: the richest variant that fits
// the pane wins. A popup opened from the CLI can be as narrow as 34 columns.
// Style tokens straight from the user's Herdr theme, so the modal renders the
// way the settings modal does rather than approximating it.
function tokens(state) {
  return themeStyles(state.theme);
}

// Resolves the header layout once, so the renderer and the click handler agree on
// exactly where each tab label sits.
function headerTabs(state, width, total) {
  const tabs = [
    { key: "installed", short: "installed", count: state.installed.length },
    { key: "notInstalled", short: "not installed", count: state.notInstalled.length },
  ].filter((t) => t.key === "installed" || state.notInstalled.length > 0);
  const counter = `${state.installed.length} / ${total} available`;

  const build = (withCounts, withCounter) => {
    let column = 1; // the leading space
    // Both chips get the same width so the filled one is a symmetrical block
    // rather than shrink-wrapping its label.
    const bodies = tabs.map((t) => `${t.short}${withCounts ? ` (${t.count})` : ""}`);
    const chipWidth = Math.max(...bodies.map((b) => b.length));
    const labels = tabs.map((t, i) => {
      const text = ` ${bodies[i].padEnd(chipWidth)} `;
      const label = {
        key: t.key, text, active: t.key === state.section,
        start: column, end: column + text.length,
      };
      column += text.length + 1;
      return label;
    });
    const plain = " " + labels.map((l) => l.text).join(" ") + " ";
    const length = plain.length + (withCounter ? counter.length : 0);
    return { labels, plain, length, withCounter, counter };
  };

  return (
    [build(true, true), build(true, false), build(false, false)].find((v) => v.length <= width) ||
    build(false, false)
  );
}

function headerLine(state, width, styled, total) {
  const variant = headerTabs(state, width, total);
  const counter = variant.counter;

  const t = tokens(state);
  const text = " " + variant.labels
    .map((l) => {
      const hovered = state.hover && state.hover.kind === "tab" && state.hover.key === l.key;
      if (l.active) return style(l.text, hovered ? t.activeTabHover : t.activeTab, styled);
      return style(l.text, hovered ? t.hoverRow : t.inactiveTab, styled);
    })
    .join(" ") + " ";

  if (!variant.withCounter) {
    return variant.plain.length <= width ? text : truncate(variant.plain, width);
  }
  const gap = Math.max(1, width - variant.plain.length - counter.length);
  return text + " ".repeat(gap) + style(counter, t.dim, styled);
}

function footerLine(state, width, styled) {
  const hint = state.section === "installed"
    ? "  ↑↓ select · tab section"
    : "  ↑↓ scroll · tab section";
  const chips = state.section === "installed"
    ? [{ label: " ⏎ hand off ", primary: true }, { label: " esc cancel ", primary: false }]
    : [{ label: " tab back ", primary: true }, { label: " esc cancel ", primary: false }];
  const short = [{ label: " ⏎ ", primary: true }, { label: " esc ", primary: false }];

  const t = tokens(state);
  const render = (list) =>
    list.map((c) => style(c.label, c.primary ? t.primaryChip : t.secondaryChip, styled)).join(" ");
  const plainOf = (list) => list.map((c) => c.label).join(" ");

  if (hint.length + plainOf(chips).length + 1 <= width) {
    const gap = width - hint.length - plainOf(chips).length;
    return style(hint, t.dim, styled) + " ".repeat(Math.max(1, gap)) + render(chips);
  }
  if (plainOf(chips).length + 1 <= width) {
    return " ".repeat(Math.max(1, width - plainOf(chips).length)) + render(chips);
  }
  if (plainOf(short).length + 1 <= width) {
    return " ".repeat(Math.max(1, width - plainOf(short).length)) + render(short);
  }
  return truncate(hint, width);
}

function renderFrame(state, opts = {}) {
  const { styled = false } = opts;
  const width = Math.max(24, state.width);
  const lines = [];
  const total = state.installed.length + state.notInstalled.length;

  // --- tabs + availability counter -----------------------------------------
  lines.push(headerLine(state, width, styled, total));

  // --- source -> destination ------------------------------------------------
  lines.push("");
  const arrow = "  →  ";
  const summary = truncate(`${state.contextLine}${arrow}${state.destination}`, width - 2);
  lines.push(style(" " + summary, tokens(state).muted, styled));
  lines.push("");

  // --- list -----------------------------------------------------------------
  const size = viewportSize(state);
  const list = items(state);
  const top = state.scroll[state.section];
  const visible = list.slice(top, top + size);
  const cols = columnWidths(list, width);

  for (const [offset, agent] of visible.entries()) {
    const index = top + offset;
    const selectable = state.section === "installed";
    const isCursor = selectable && index === state.cursor;
    const row = agentRow(agent, { marker: isCursor ? "▸" : " ", width, ...cols });

    const t = tokens(state);
    const hovered = state.hover && state.hover.kind === "row" && state.hover.index === index &&
      state.hover.section === state.section;
    if (isCursor) {
      lines.push(style(pad(row, width), t.cursorRow, styled));
    } else if (hovered) {
      // Every row highlight spans the full width, so the fill is a clean block.
      lines.push(style(pad(row, width), t.hoverRow, styled));
    } else if (selectable) {
      lines.push(style(row, t.muted, styled));
    } else {
      lines.push(style(row, t.dim, styled));
    }
  }

  for (let i = visible.length; i < size; i += 1) lines.push("");

  // --- footer ---------------------------------------------------------------
  lines.push("");
  lines.push(footerLine(state, width, styled));

  return lines.slice(0, state.height);
}

// A single frame shown after a choice so the selection is visibly acknowledged
// rather than the popup just blinking out.
function renderChosenFrame(state, opts = {}) {
  const { styled = false } = opts;
  const agent = state.installed.find((a) => a.kind === state.chosen);
  const name = agent ? agent.name : state.chosen;
  const frame = renderFrame(state, opts);
  const message = `  ✓ handing off to ${name}…`;
  frame[frame.length - 1] = style(truncate(message, state.width), tokens(state).accentText, styled);
  return frame;
}

module.exports = {
  decodeInput,
  initialState,
  applyKey,
  applyClick,
  applyHover,
  renderFrame,
  renderChosenFrame,
  viewportSize,
};
