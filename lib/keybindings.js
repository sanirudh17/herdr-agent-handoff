"use strict";

const path = require("node:path");

const KEYS = ["prefix+a", "prefix+shift+a"];
const ACTIONS = ["agent-handoff.handoff-split", "agent-handoff.handoff-tab"];
const MARKER = "# Added by the Agent Handoff plugin.";

const BLOCKS = `${MARKER}
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "agent-handoff.handoff-split"
description = "handoff to agent (split)"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "agent-handoff.handoff-tab"
description = "handoff to agent (new tab)"
`;

function findConfigPath({ env = process.env, helpOutput = "" } = {}) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  const match = String(helpOutput).match(/^Config:\s+(.+?)\s*$/m);
  if (match) return match[1];
  const home = env.USERPROFILE || env.HOME;
  if (!home) return null;
  return path.join(home, ".config", "herdr", "config.toml");
}

function activeLines(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
}

// Removes any [[keys.command]] block already targeting one of our actions, so a
// re-run replaces a stale binding instead of appending a duplicate.
function stripOurBlocks(text) {
  const lines = text.split(/\r?\n/);
  const keep = [];
  let block = null;

  const flush = () => {
    if (!block) return;
    const isOurs = block.some((line) => ACTIONS.some((action) => line.includes(`"${action}"`)));
    if (!isOurs) keep.push(...block);
    block = null;
  };

  for (const line of lines) {
    if (line.trim() === MARKER) continue;
    if (/^\s*\[\[keys\.command\]\]/.test(line)) {
      flush();
      block = [line];
      continue;
    }
    if (block) {
      if (/^\s*\[/.test(line)) {
        flush();
        keep.push(line);
        continue;
      }
      block.push(line);
      continue;
    }
    keep.push(line);
  }
  flush();

  return keep.join("\n").replace(/\n{3,}/g, "\n\n");
}

function patch(text, opts = {}) {
  const { force = false } = opts;
  const original = text;
  const cleaned = stripOurBlocks(text);
  const cleanedActive = activeLines(cleaned);
  const conflicts = KEYS.filter((key) =>
    cleanedActive.some((line) => line.includes(`"${key}"`))
  );

  if (conflicts.length > 0 && !force) {
    return { text: original, changed: false, conflicts };
  }

  const base = cleaned.replace(/\s*$/, "");
  const next = base.length > 0 ? `${base}\n\n${BLOCKS}` : BLOCKS;
  return { text: next, changed: next !== original, conflicts: [] };
}

module.exports = { BLOCKS, KEYS, ACTIONS, MARKER, patch, findConfigPath };
