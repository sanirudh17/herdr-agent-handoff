#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const ipc = require("../lib/ipc.js");
const ui = require("../lib/ui.js");

const HEADLESS = process.env.HANDOFF_PICKER_HEADLESS === "1";

function loadRequest() {
  const file = process.env.HERDR_HANDOFF_REQUEST;
  if (!file) throw new Error("HERDR_HANDOFF_REQUEST is not set");
  return { file, request: ipc.readJson(file) };
}

function buildState(request) {
  return ui.initialState({
    title: "Handoff to Agent",
    contextLine: request.contextLine,
    available: request.available,
    unavailable: request.unavailable || [],
    unavailableCount: request.unavailableCount || 0,
    width: HEADLESS ? 78 : Math.max(40, process.stdout.columns || 78),
    height: HEADLESS ? 20 : Math.max(12, process.stdout.rows || 20),
  });
}

function drawHeadless(state) {
  process.stdout.write(ui.renderFrame(state).join("\n") + "\n\f");
}

function draw(state) {
  process.stdout.write("\x1b[H\x1b[2J" + ui.renderFrame(state).join("\r\n"));
}

function finish(resultPath, payload, teardown) {
  if (teardown) teardown();
  ipc.writeJson(resultPath, payload);
  process.exit(0);
}

function runHeadless(request) {
  let state = buildState(request);
  drawHeadless(state);

  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    input = "";
  }

  for (const key of input.split("\n").map((k) => k.trim()).filter(Boolean)) {
    const out = ui.applyKey(state, key);
    state = out.state;
    drawHeadless(state);
    if (out.action && out.action.select) {
      return finish(request.resultPath, { selected: out.action.select }, null);
    }
    if (out.action && out.action.cancel) {
      return finish(request.resultPath, { cancelled: true }, null);
    }
  }

  return finish(request.resultPath, { cancelled: true }, null);
}

function runInteractive(request) {
  let state = buildState(request);
  const { stdin, stdout } = process;

  // Alternate screen, hide cursor, enable SGR mouse reporting.
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  const teardown = () => {
    stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  draw(state);

  stdin.on("data", (buf) => {
    for (const event of ui.decodeInput(buf)) {
      const out = event.type === "mouse"
        ? ui.applyClick(state, event.row)
        : ui.applyKey(state, event.name);
      state = out.state;
      if (out.action && out.action.select) {
        finish(request.resultPath, { selected: out.action.select }, teardown);
        return;
      }
      if (out.action && out.action.cancel) {
        finish(request.resultPath, { cancelled: true }, teardown);
        return;
      }
    }
    draw(state);
  });

  stdin.on("end", () => finish(request.resultPath, { cancelled: true }, teardown));
  process.on("SIGINT", () => finish(request.resultPath, { cancelled: true }, teardown));
  process.on("SIGTERM", () => finish(request.resultPath, { cancelled: true }, teardown));
}

function main() {
  let loaded;
  try {
    loaded = loadRequest();
  } catch (err) {
    process.stderr.write(`agent-handoff picker: ${err.message}\n`);
    process.exit(1);
    return;
  }
  if (HEADLESS) runHeadless(loaded.request);
  else runInteractive(loaded.request);
}

main();
