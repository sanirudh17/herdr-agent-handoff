"use strict";

const path = require("node:path");

// Herdr reports the plugin root as a Windows verbatim path (\\?\C:\...) and uses
// it as a plugin pane's cwd. Node cannot resolve a relative main script from such
// a cwd — realpathSync treats "C:" as a path component and throws
// EISDIR during resolveMainPath — so the prefix has to come off before the path
// is used to launch anything.
function stripVerbatim(p) {
  if (!p) return "";
  return String(p).replace(/^\\\\\?\\/, "");
}

function pluginRoot(env = process.env) {
  return stripVerbatim(env.HERDR_PLUGIN_ROOT || process.cwd());
}

function stateDir(env = process.env) {
  return env.HERDR_PLUGIN_STATE_DIR || path.resolve(".agent-handoff-state");
}

function configDir(env = process.env) {
  return env.HERDR_PLUGIN_CONFIG_DIR || path.resolve(".agent-handoff-config");
}

// There is no handoffs directory. The handoff travels inside the prompt, and a
// session too large to inline is read by the target from where its own agent put
// it, so the plugin has nothing to store.

function requestsDir(env = process.env) {
  return path.join(stateDir(env), "requests");
}

module.exports = {
  stateDir,
  configDir,
  requestsDir,
  stripVerbatim,
  pluginRoot,
};
