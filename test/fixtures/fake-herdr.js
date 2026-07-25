#!/usr/bin/env node
"use strict";

const args = process.argv.slice(2);

if (args[0] === "fail-envelope") {
  process.stdout.write(
    JSON.stringify({ error: { code: "pane_not_found", message: "pane w99:p99 not found" }, id: "cli:pane:get" }) + "\n"
  );
  process.exit(1);
}

if (args[0] === "fail-garbage") {
  process.stdout.write("not json at all\n");
  process.exit(1);
}

if (args[0] === "ok-garbage") {
  process.stdout.write("not json at all\n");
  process.exit(0);
}

if (args[0] === "bom") {
  process.stdout.write("﻿" + JSON.stringify({ id: "cli:test", result: { type: "echo", args } }) + "\n");
  process.exit(0);
}

if (args[0] === "plain") {
  process.stdout.write("Config: /home/u/.config/herdr/config.toml\n");
  process.exit(0);
}

process.stdout.write(JSON.stringify({ id: "cli:test", result: { type: "echo", args } }) + "\n");
process.exit(0);
