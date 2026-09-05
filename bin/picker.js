#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ipc = require("../lib/ipc.js");
const ui = require("../lib/ui.js");
const updateMod = require("../lib/update.js");

const HEADLESS = process.env.HANDOFF_PICKER_HEADLESS === "1";
// How long the chosen agent stays on screen before the popup closes.
const CONFIRM_MS = HEADLESS ? 0 : 450;

// The picker runs inside a popup pane whose terminal disappears the moment the
// process ends, taking any stderr with it. Without this trace a crash in here is
// completely invisible: the popup just blinks and the waiting action hangs.
const TRACE = process.env.HANDOFF_PICKER_TRACE === "0" ? null : traceFile();

function traceFile() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) return null;
  return path.join(dir, "picker.log");
}

const TRACE_MAX_BYTES = 64 * 1024;

function trace(message) {
  if (!TRACE) return;
  try {
    // Keep the log bounded; it is a rolling record of recent launches only.
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
  const file = process.env.HERDR_HANDOFF_REQUEST;
  if (!file) throw new Error("HERDR_HANDOFF_REQUEST is not set");
  return { file, request: ipc.readJson(file) };
}

function buildState(request) {
  const notice = updateMod.checkUpdateAsync();
  return ui.initialState({
    contextLine: request.contextLine,
    destination: request.destination,
    installed: request.installed,
    notInstalled: request.notInstalled || [],
    theme: request.theme || null,
    updateNotice: notice.available ? notice : null,
    // Use the pane's real size; the frame budgets every column from it so
    // nothing wraps, even in a 34-column popup.
    width: HEADLESS ? 78 : Math.max(24, process.stdout.columns || 78),
    height: HEADLESS ? 20 : Math.max(10, process.stdout.rows || 20),
  });
}

function drawHeadless(state) {
  process.stdout.write(ui.renderFrame(state).join("\n") + "\n\f");
}

// Runs the upgrade the notice advertises and folds the outcome back into
// picker state. applyKey has already set updating:true, so the footer shows
// the Updating line while the install blocks. Never throws: a failed upgrade
// keeps the notice (retryable, dismissible) and the picker fully usable.
function runInstall(state) {
  const version =
    state.updateNotice && state.updateNotice.version
      ? state.updateNotice.version
      : "unknown";
  let result;
  try {
    result = updateMod.installUpdate();
  } catch (err) {
    result = {
      ok: false,
      message: (err && err.message ? err.message : String(err)).slice(0, 120),
    };
  }
  trace(`install update v${version}: ${result.ok ? "ok" : result.message}`);
  if (result.ok) {
    return {
      ...state,
      updating: false,
      updateNotice: null,
      updateStatus: { ok: true, version },
      settledAt: Date.now(),
    };
  }
  return {
    ...state,
    updating: false,
    updateStatus: { ok: false, message: result.message },
    settledAt: Date.now(),
  };
}

function draw(state, frame) {
  const lines = frame || ui.renderFrame(state, { styled: true });
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
    const out = ui.applyKey(state, key);
    state = out.state;
    if (out.action && out.action.installUpdate) {
      drawHeadless(state); // updating line, before the blocking install
      state = runInstall(state);
    }
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

  // Alternate screen, hide cursor, SGR mouse reporting. 1003 reports motion too,
  // which is what makes hover highlighting possible.
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1003h\x1b[?1006h");
  const teardown = () => {
    stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  draw(state);
  trace("interactive loop armed");

  stdin.on("error", (err) => trace(`stdin error ${err.message}`));
  stdin.on("close", () => trace("stdin close"));

  stdin.on("data", (buf) => {
    trace(`stdin data ${JSON.stringify(buf.toString("binary"))}`);
    for (const event of ui.decodeInput(buf)) {
      if (event.type === "hover") {
        state = ui.applyHover(state, event.row, event.col);
        continue;
      }
      const out =
        event.type === "mouse"
          ? ui.applyClick(state, event.row, event.col)
          : ui.applyKey(state, event.name);
      state = out.state;
      if (out.action && out.action.dismissUpdate) {
        updateMod.dismissUpdate(out.action.dismissUpdate);
      }
      if (out.action && out.action.installUpdate) {
        // Show the Updating line first: stdout to a terminal flushes on
        // write, so the user sees it before the blocking install starts.
        draw(state);
        state = runInstall(state);
        draw(state);
        continue;
      }
      // Keys hammered while the install blocked arrive as one buffered burst
      // the moment input flows again. A select/cancel among them was aimed
      // at the install, not the picker — drop it rather than handing off or
      // blinking out from under the user.
      if (
        state.settledAt &&
        Date.now() - state.settledAt < 500 &&
        out.action &&
        (out.action.select || out.action.cancel)
      ) {
        state = { ...state, settledAt: 0 };
        draw(state);
        continue;
      }
      if (out.action && out.action.select) {
        // Show the choice before the popup disappears, so the selection is
        // acknowledged rather than the modal just blinking out.
        draw(state, ui.renderChosenFrame(state, { styled: true }));
        setTimeout(
          () =>
            finish(
              request.resultPath,
              { selected: out.action.select },
              teardown,
            ),
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
    trace("stdin end -> cancel");
    finish(request.resultPath, { cancelled: true }, teardown);
  });
  process.on("SIGINT", () => {
    trace("SIGINT -> cancel");
    finish(request.resultPath, { cancelled: true }, teardown);
  });
  process.on("SIGTERM", () => {
    trace("SIGTERM -> cancel");
    finish(request.resultPath, { cancelled: true }, teardown);
  });
  process.on("SIGHUP", () => {
    trace("SIGHUP -> cancel");
    finish(request.resultPath, { cancelled: true }, teardown);
  });
}

function main() {
  trace(
    `start headless=${HEADLESS} cwd=${process.cwd()} ` +
      `isTTY=${Boolean(process.stdin.isTTY)} cols=${process.stdout.columns} rows=${process.stdout.rows} ` +
      `request=${process.env.HERDR_HANDOFF_REQUEST || "UNSET"}`,
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
    process.stderr.write(`agent-handoff picker: ${err.message}\n`);
    process.exit(1);
    return;
  }

  trace(`request loaded, ${loaded.request.installed.length} agents available`);
  if (HEADLESS) runHeadless(loaded.request);
  else runInteractive(loaded.request);
}

main();
