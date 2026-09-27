#!/usr/bin/env node
"use strict";

// Non-interactive entrypoint for automation (swap/dispatcher integrations).
// Target and context are explicit so no picker pane is ever opened.
//
// The manifest action (`handoff-headless` in herdr-plugin.toml) carries no
// arguments, so every flag also has an env fallback and --target stays
// required: without a target there is nothing safe to default to.
// Precedence everywhere is: CLI flag > specific env var > built-in default.
const { run, HANDOFF_MODES } = require("../lib/handoff.js");

function rawValue(argv, name) {
  const eq = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      const candidate = argv[i + 1];
      return candidate && !candidate.startsWith("--") ? candidate : null;
    }
    if (argv[i].startsWith(eq)) {
      const candidate = argv[i].slice(eq.length);
      return candidate && !candidate.startsWith("--") ? candidate : null;
    }
  }
  return null;
}

function value(argv, env, name, envName, fallback = null) {
  const fromArgv = rawValue(argv, name);
  if (fromArgv !== null) return fromArgv;
  const fromEnv =
    env && typeof env[envName] === "string" && env[envName].trim()
      ? env[envName].trim()
      : null;
  if (fromEnv !== null) return fromEnv;
  return fallback;
}

// Herdr pane actions run with the action's pane as the focused pane, exposed
// through HERDR_PLUGIN_CONTEXT_JSON. HERDR_PANE_ID is honoured first when a
// dispatcher sets it explicitly; otherwise the focused pane id is used, so a
// plain shell without either is rejected safely by run() downstream.
function resolveHeadlessSource(env) {
  if (env && typeof env.HERDR_PANE_ID === "string" && env.HERDR_PANE_ID) {
    return env.HERDR_PANE_ID;
  }
  try {
    const ctx = JSON.parse((env && env.HERDR_PLUGIN_CONTEXT_JSON) || "{}");
    return ctx.focused_pane_id || null;
  } catch {
    return null;
  }
}

function parseHeadlessArgs(argv, env = process.env) {
  const target = value(argv, env, "--target", "HERDR_HANDOFF_TARGET");
  const destination = value(
    argv,
    env,
    "--destination",
    "HERDR_HANDOFF_DESTINATION",
    "split",
  );
  const mode = value(
    argv,
    env,
    "--mode",
    "HERDR_HANDOFF_MODE",
    env.HANDOFF_MODE || env.HANDOFF_HANDOFF_MODE || "focused",
  );
  return { target, destination, mode };
}

function validateHeadless({ target, destination, mode }) {
  if (
    !target ||
    !["split", "tab"].includes(destination) ||
    !HANDOFF_MODES.includes(mode)
  ) {
    return false;
  }
  return true;
}

function usage() {
  process.stderr.write(
    "usage: handoff-headless.js --target KIND [--destination split|tab] [--mode focused|full]\n",
  );
}

function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseHeadlessArgs(argv, env);
  if (!validateHeadless(parsed)) {
    usage();
    process.exitCode = 2;
    return Promise.resolve({ ok: false, exitCode: 2 });
  }
  return run({
    destination: parsed.destination,
    handoffMode: parsed.mode,
    pickerChoice: { selected: parsed.target },
    sourcePaneId: resolveHeadlessSource(env),
    validateTarget: true,
    env,
  })
    .then((result) => {
      if (!result || !result.ok) {
        process.stderr.write(
          `${(result && (result.message || result.detail)) || "handoff failed"}\n`,
        );
        process.exitCode = 1;
      }
      return result;
    })
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
      throw err;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseHeadlessArgs,
  resolveHeadlessSource,
  validateHeadless,
};
