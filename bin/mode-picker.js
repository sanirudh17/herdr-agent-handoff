#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ipc = require("../lib/ipc.js");
const modeUi = require("../lib/mode-ui.js");
const ui = require("../lib/ui.js");

const HEADLESS =
  process.env.HANDOFF_PICKER_HEADLESS === "1" ||
  process.env.HANDOFF_MODE_PICKER_HEADLESS === "1";
const CONFIRM_MS = HEADLESS ? 0 : 450;

const TRACE = process.env.HANDOFF_PICKER_TRACE === "0" ? null : traceFile();

function traceFile() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) return null;
  return path.join(dir, "mode-picker.log");
}

const TRACE_MAX_BYTES = 64 * 1024;

function trace(message) {
  if (!TRACE) return;
  try {
    if (fs.existsSync(TRACE) && fs.statSync(TRACE).size > TRACE_MAX_BYTES) {
      fs.rmSync(TRACE, { force: true });
    }
    fs.appendFileSync(
      TRACE,
      `${new Date().toISOString()} pid=${process.pid} ${message}\n`,
    );
  } catch {
    // diagnostics must never break the picker
  }
}

function loadRequest() {
  const file =
    process.env.HERDR_HANDOFF_MODE_REQUEST || process.env.HERDR_HANDOFF_REQUEST;
  if (!file) throw new Error("HERDR_HANDOFF_REQUEST is not set");
  return { file, request: ipc.readJson(file) };
}

function buildState(request) {
  return modeUi.initialState({
    contextLine: request.contextLine || "",
    theme: request.theme || null,
    width: HEADLESS ? 78 : Math.max(24, process.stdout.columns || 78),
    height: HEADLESS ? 20 : Math.max(10, process.stdout.rows || 20),
  });
}

function drawHeadless(state) {
  process.stdout.write(modeUi.renderFrame(state).join("\n") + "\n\f");
}

function draw(state, frame) {
  const lines = frame || modeUi.renderFrame(state, { styled: true });
  process.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"));
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
    // stdin closed or not a file; nothing to read
  }

  for (const key of input
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean)) {
    const out = modeUi.applyKey(state, key);
    state = out.state;
    drawHeadless(state);
    if (out.action && out.action.mode) {
      return finish(request.resultPath, { mode: out.action.mode }, null);
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

  stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1003h\x1b[?1006h");
  const teardown = () => {
    stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  draw(state);
  trace("mode interactive loop armed");

  stdin.on("data", (buf) => {
    for (const event of ui.decodeInput(buf)) {
      if (event.type === "hover") {
        state = modeUi.applyHover(state, event.row);
        continue;
      }
      const out =
        event.type === "mouse"
          ? modeUi.applyClick(state, event.row)
          : modeUi.applyKey(state, event.name);
      state = out.state;
      if (out.action && out.action.mode) {
        draw(state, modeUi.renderChosenFrame(state, { styled: true }));
        setTimeout(
          () => finish(request.resultPath, { mode: out.action.mode }, teardown),
          CONFIRM_MS,
        );
        return;
      }
      if (out.action && out.action.cancel) {
        finish(request.resultPath, { cancelled: true }, teardown);
        return;
      }
    }
    draw(state);
  });

  stdin.on("end", () => {
    finish(request.resultPath, { cancelled: true }, teardown);
  });
  process.on("SIGINT", () => {
    finish(request.resultPath, { cancelled: true }, teardown);
  });
  process.on("SIGTERM", () => {
    finish(request.resultPath, { cancelled: true }, teardown);
  });
  process.on("SIGHUP", () => {
    finish(request.resultPath, { cancelled: true }, teardown);
  });
}

function main() {
  trace(
    `start headless=${HEADLESS} cwd=${process.cwd()} ` +
      `isTTY=${Boolean(process.stdin.isTTY)} cols=${process.stdout.columns} rows=${process.stdout.rows} ` +
      `request=${process.env.HERDR_HANDOFF_MODE_REQUEST || process.env.HERDR_HANDOFF_REQUEST || "UNSET"}`,
  );

  process.on("uncaughtException", (err) => {
    trace(`uncaughtException ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
  process.on("exit", (code) => trace(`exit code=${code}`));

  let loaded;
  try {
    loaded = loadRequest();
  } catch (err) {
    trace(`loadRequest failed: ${err.message}`);
    process.stderr.write(`agent-handoff mode-picker: ${err.message}\n`);
    process.exit(1);
    return;
  }

  if (HEADLESS) runHeadless(loaded.request);
  else runInteractive(loaded.request);
}

main();
