#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const herdr = require("../lib/herdr.js");
const kb = require("../lib/keybindings.js");

function helpOutput() {
  try {
    return herdr.run(["--help"], { json: false });
  } catch {
    return "";
  }
}

function notify(title) {
  try {
    herdr.run(["notification", "show", title]);
  } catch {
    // best effort
  }
}

function main() {
  const force = process.argv.includes("--force");
  const configPath = kb.findConfigPath({
    env: process.env,
    helpOutput: helpOutput(),
  });

  if (!configPath) {
    process.stderr.write("agent-handoff: could not locate config.toml\n");
    notify("Agent Handoff: could not locate config.toml");
    process.exit(1);
  }

  let existing = "";
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, "utf8");
    const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(configPath, backup);
    process.stdout.write(`backed up ${configPath} to ${backup}\n`);
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const out = kb.patch(existing, { force });

  if (!out.changed && out.conflicts.length > 0) {
    const list = out.conflicts.join(", ");
    process.stderr.write(
      `agent-handoff: ${list} already bound to something else; re-run with --force to override\n`,
    );
    notify(
      `Agent Handoff: ${list} already bound. Re-run setup-keys with --force.`,
    );
    process.exit(1);
  }

  if (!out.changed) {
    process.stdout.write("agent-handoff keybindings already installed\n");
    notify("Agent Handoff: keybindings already installed");
    process.exit(0);
  }

  fs.writeFileSync(configPath, out.text);
  process.stdout.write(`wrote agent-handoff keybindings to ${configPath}\n`);

  try {
    herdr.run(["server", "reload-config"]);
  } catch (err) {
    process.stderr.write(
      `agent-handoff: reload-config failed: ${err.message}\n`,
    );
    notify("Agent Handoff: keys written, reload config manually");
    process.exit(1);
  }

  notify("Agent Handoff: prefix+a and prefix+shift+a installed");
  process.exit(0);
}

main();
