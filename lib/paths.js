"use strict";

const path = require("node:path");

function stateDir(env = process.env) {
  return env.HERDR_PLUGIN_STATE_DIR || path.resolve(".agent-handoff-state");
}

function configDir(env = process.env) {
  return env.HERDR_PLUGIN_CONFIG_DIR || path.resolve(".agent-handoff-config");
}

function handoffsDir(env = process.env) {
  return path.join(stateDir(env), "handoffs");
}

function requestsDir(env = process.env) {
  return path.join(stateDir(env), "requests");
}

module.exports = { stateDir, configDir, handoffsDir, requestsDir };
