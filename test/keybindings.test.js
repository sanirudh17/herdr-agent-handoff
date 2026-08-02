const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const kb = require("../lib/keybindings.js");

test("both keys and both action ids appear in the blocks", () => {
  assert.match(kb.BLOCKS, /key = "prefix\+a"/);
  assert.match(kb.BLOCKS, /key = "prefix\+shift\+a"/);
  assert.match(kb.BLOCKS, /command = "agent-handoff\.handoff-split"/);
  assert.match(kb.BLOCKS, /command = "agent-handoff\.handoff-tab"/);
  assert.match(kb.BLOCKS, /type = "plugin_action"/);
  assert.deepEqual(kb.KEYS, ["prefix+a", "prefix+shift+a"]);
});

test("patch appends the blocks to an empty config", () => {
  const out = kb.patch("");
  assert.equal(out.changed, true);
  assert.deepEqual(out.conflicts, []);
  assert.match(out.text, /agent-handoff\.handoff-split/);
});

test("patch is idempotent", () => {
  const once = kb.patch("");
  const twice = kb.patch(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
  assert.equal((twice.text.match(/handoff-split/g) || []).length, 1);
});

test("patch preserves existing config content", () => {
  const existing = '[theme]\nname = "nord"\n';
  const out = kb.patch(existing);
  assert.ok(out.text.startsWith(existing));
  assert.match(out.text, /handoff-tab/);
});

test("patch refuses when prefix+a is already bound elsewhere", () => {
  const existing = '[keys]\nfocus_pane_left = "prefix+a"\n';
  const out = kb.patch(existing);
  assert.equal(out.changed, false);
  assert.deepEqual(out.conflicts, ["prefix+a"]);
  assert.equal(out.text, existing);
});

test("patch refuses when prefix+shift+a belongs to another command", () => {
  const existing = '[[keys.command]]\nkey = "prefix+shift+a"\ntype = "popup"\ncommand = "lazygit"\n';
  const out = kb.patch(existing);
  assert.equal(out.changed, false);
  assert.deepEqual(out.conflicts, ["prefix+shift+a"]);
});

test("patch with force overrides a conflicting binding", () => {
  const existing = '[keys]\nfocus_pane_left = "prefix+a"\n';
  const out = kb.patch(existing, { force: true });
  assert.equal(out.changed, true);
  assert.match(out.text, /handoff-split/);
});

test("patch ignores commented-out bindings when detecting conflicts", () => {
  const existing = '[keys]\n# focus_pane_left = "prefix+a"\n';
  const out = kb.patch(existing);
  assert.equal(out.changed, true);
  assert.deepEqual(out.conflicts, []);
});

test("patch replaces a stale block rather than duplicating it", () => {
  const stale = [
    "[[keys.command]]",
    'key = "prefix+z"',
    'type = "plugin_action"',
    'command = "agent-handoff.handoff-split"',
    "",
  ].join("\n");
  const out = kb.patch(stale);
  assert.equal(out.changed, true);
  assert.equal((out.text.match(/handoff-split/g) || []).length, 1);
  assert.match(out.text, /key = "prefix\+a"/);
  assert.ok(!out.text.includes('key = "prefix+z"'));
});

test("patch removes an obsolete agent-handoff key even when current keys exist", () => {
  const config = [
    '[[keys.command]]',
    'key = "prefix+a"',
    'type = "plugin_action"',
    'command = "agent-handoff.handoff-split"',
    "",
    '[[keys.command]]',
    'key = "ctrl+a"',
    'type = "plugin_action"',
    'command = "agent-handoff.handoff-split"',
    "",
    '[[keys.command]]',
    'key = "prefix+shift+a"',
    'type = "plugin_action"',
    'command = "agent-handoff.handoff-tab"',
    "",
  ].join("\n");
  const out = kb.patch(config);
  assert.equal(out.changed, true);
  assert.ok(!out.text.includes('key = "ctrl+a"'));
  assert.deepEqual(
    [...out.text.matchAll(/key = "([^"]+)"/g)].map((match) => match[1]),
    ["prefix+a", "prefix+shift+a"]
  );
});

test("findConfigPath prefers HERDR_CONFIG_PATH", () => {
  const p = path.join(path.sep, "custom", "config.toml");
  assert.equal(kb.findConfigPath({ env: { HERDR_CONFIG_PATH: p }, helpOutput: "" }), p);
});

test("findConfigPath reads the Config line from herdr --help", () => {
  const p = path.join(path.sep, "home", "u", ".config", "herdr", "config.toml");
  const help = `Usage: herdr\n\nConfig: ${p}\nLogs:   /var/log/herdr.log\n`;
  assert.equal(kb.findConfigPath({ env: {}, helpOutput: help }), p);
});

test("findConfigPath falls back to the documented default", () => {
  const got = kb.findConfigPath({ env: { HOME: path.join(path.sep, "h") }, helpOutput: "" });
  assert.equal(got, path.join(path.sep, "h", ".config", "herdr", "config.toml"));
});
