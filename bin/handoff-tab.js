#!/usr/bin/env node
"use strict";

const { run } = require("../lib/handoff.js");

run({ destination: "tab", dryRun: process.argv.includes("--dry-run") })
  .then((out) => {
    if (out.message) process.stdout.write(out.message + "\n");
    process.exit(out.ok || out.cancelled ? 0 : 1);
  })
  .catch((err) => {
    process.stderr.write(`agent-handoff: ${err.stack || err.message}\n`);
    process.exit(1);
  });
