const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const agents = require("../lib/agents.js");

function tempPathDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-path-"));
  for (const name of files) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("registry covers all 21 startable kinds", () => {
  assert.equal(agents.AGENTS.length, 21);
  assert.equal(agents.TOTAL_COUNT, 21);
  const kinds = agents.AGENTS.map((a) => a.kind);
  for (const k of ["pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
    "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes",
    "kilo", "qodercli", "maki"]) {
    assert.ok(kinds.includes(k), `missing kind ${k}`);
  }
  assert.equal(new Set(kinds).size, 21, "kinds must be unique");
});

test("exactly the 15 integrated agents can be sources", () => {
  assert.equal(agents.SOURCE_KINDS.size, 15);
  for (const k of ["claude", "codex", "copilot", "devin", "droid", "kimi", "omp", "mastracode",
    "pi", "hermes", "opencode", "qodercli", "kilo", "cursor", "grok"]) {
    assert.ok(agents.SOURCE_KINDS.has(k), `${k} should be a source kind`);
  }
  for (const k of ["gemini", "agy", "cline", "kiro", "amp", "maki"]) {
    assert.ok(!agents.SOURCE_KINDS.has(k), `${k} must not be a source kind`);
  }
});

test("every agent has a friendly name and at least one executable candidate", () => {
  for (const a of agents.AGENTS) {
    assert.ok(a.name && a.name.length > 0, `${a.kind} needs a name`);
    assert.ok(Array.isArray(a.exec) && a.exec.length > 0, `${a.kind} needs exec candidates`);
  }
});

test("alias executables are registered for the renamed CLIs", () => {
  assert.ok(agents.byKind("cursor").exec.includes("cursor-agent"));
  assert.ok(agents.byKind("qodercli").exec.includes("qoder"));
  assert.ok(agents.byKind("agy").exec.includes("antigravity"));
  assert.ok(agents.byKind("hermes").exec.includes("hermes-agent"));
  assert.ok(agents.byKind("grok").exec.includes("grok-build"));
});

test("resolveExecutable finds a plain executable on PATH", () => {
  const dir = tempPathDir(["claude"]);
  const found = agents.resolveExecutable("claude", { PATH: dir, PATHEXT: "" });
  assert.equal(found, path.join(dir, "claude"));
});

// PATHEXT resolution only applies on Windows, so these two are Windows-only.
const winOnly = { skip: process.platform !== "win32" ? "Windows-only behaviour" : false };

test("resolveExecutable honours PATHEXT for Windows-style shims", winOnly, () => {
  const dir = tempPathDir(["claude.cmd"]);
  const found = agents.resolveExecutable("claude", { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" });
  assert.equal(found, path.join(dir, "claude.cmd"));
});

test("resolveExecutable also matches .ps1 shims absent from PATHEXT", winOnly, () => {
  const dir = tempPathDir(["pi.ps1"]);
  const found = agents.resolveExecutable("pi", { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" });
  assert.equal(found, path.join(dir, "pi.ps1"));
});

test("resolveExecutable returns null when nothing matches", () => {
  const dir = tempPathDir([]);
  assert.equal(agents.resolveExecutable("claude", { PATH: dir, PATHEXT: "" }), null);
});

test("available reflects the filesystem on every call, not a stale cache", () => {
  const dir = tempPathDir(["claude"]);
  const env = { PATH: dir, PATHEXT: "" };
  assert.deepEqual(agents.available(env).map((a) => a.kind), ["claude"]);
  fs.writeFileSync(path.join(dir, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(agents.available(env).map((a) => a.kind).sort(), ["claude", "cursor"]);
});

test("available reports which executable candidate resolved", () => {
  const dir = tempPathDir(["cursor-agent"]);
  const cursor = agents.available({ PATH: dir, PATHEXT: "" }).find((a) => a.kind === "cursor");
  assert.equal(cursor.execName, "cursor-agent");
});

test("available reports only agents whose executable resolves, first candidate wins", () => {
  const dir = tempPathDir(["claude", "cursor-agent"]);
  const list = agents.available({ PATH: dir, PATHEXT: "" });
  const kinds = list.map((a) => a.kind);
  assert.deepEqual(kinds.sort(), ["claude", "cursor"]);
  assert.equal(list.find((a) => a.kind === "cursor").executable, path.join(dir, "cursor-agent"));
});
