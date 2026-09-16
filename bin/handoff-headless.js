#!/usr/bin/env node
"use strict";

// Non-interactive entrypoint for automation (swap/dispatcher integrations).
// Target and context are explicit so no picker pane is ever opened.
const { run, HANDOFF_MODES } = require("../lib/handoff.js");

function value(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const candidate = process.argv[i + 1];
  return candidate && !candidate.startsWith("--") ? candidate : null;
}

function usage() {
  process.stderr.write(
    "usage: handoff-headless.js --target KIND [--destination split|tab] [--mode focused|full]\n",
  );
}

const target = value("--target");
const destination = value("--destination", "split");
const mode = value("--mode", process.env.HANDOFF_HANDOFF_MODE || "focused");
if (!target || !["split", "tab"].includes(destination) || !HANDOFF_MODES.includes(mode)) {
  usage();
  process.exitCode = 2;
} else {
  run({
    destination,
    handoffMode: mode,
    pickerChoice: { selected: target },
    sourcePaneId: process.env.HERDR_PANE_ID || null,
    validateTarget: true,
    env: process.env,
  })
    .then((result) => {
      if (!result || !result.ok) {
        process.stderr.write(`${(result && (result.message || result.detail)) || "handoff failed"}\n`);
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}
