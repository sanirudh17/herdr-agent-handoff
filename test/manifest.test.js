const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = fs.readFileSync(path.join(__dirname, "..", "herdr-plugin.toml"), "utf8");

// Regression guard for the Windows popup failure.
//
// Herdr sets a plugin pane's cwd to the plugin root as a Windows *verbatim* path
// (\\?\C:\...). Node cannot resolve a relative main script from such a cwd:
// realpathSync walks the components and dies with
// "EISDIR: illegal operation on a directory, lstat 'C:'" during resolveMainPath,
// before any plugin code executes. The popup therefore blinked and vanished, and
// the waiting action hung with no result file.
//
// The pane command must not depend on cwd at all.
test("the picker pane command does not rely on the process cwd", () => {
  const block = MANIFEST.split(/^\[\[panes\]\]/m).find((b) => /id\s*=\s*"picker"/.test(b));
  assert.ok(block, "expected a [[panes]] entry with id = \"picker\"");
  const command = block.match(/command\s*=\s*(\[[\s\S]*?\])/);
  assert.ok(command, "picker pane must declare a command");

  assert.ok(
    !/["']bin\/picker\.js["']/.test(command[1]),
    "picker must not be launched by a bare relative script path; Node cannot resolve one " +
      "from the \\\\?\\ cwd Herdr gives plugin panes on Windows"
  );
  assert.match(
    command[1],
    /HERDR_PLUGIN_ROOT/,
    "picker should locate itself from HERDR_PLUGIN_ROOT rather than the cwd"
  );
});

test("the manifest ships no diagnostic probe pane", () => {
  assert.ok(!/id\s*=\s*"probe"/.test(MANIFEST), "the debug probe pane must not be committed");
});

test("declared action and pane ids are unique", () => {
  const ids = [...MANIFEST.matchAll(/^id\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in manifest: ${ids.join(", ")}`);
});
