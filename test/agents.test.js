const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const agents = require("../lib/agents.js");

function tempPathDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-path-"));
  for (const name of files)
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("registry covers all 21 startable kinds", () => {
  assert.equal(agents.AGENTS.length, 21);
  assert.equal(agents.TOTAL_COUNT, 21);
  const kinds = agents.AGENTS.map((a) => a.kind);
  for (const k of [
    "pi",
    "claude",
    "codex",
    "gemini",
    "cursor",
    "devin",
    "agy",
    "cline",
    "omp",
    "mastracode",
    "opencode",
    "copilot",
    "kimi",
    "kiro",
    "droid",
    "amp",
    "grok",
    "hermes",
    "kilo",
    "qodercli",
    "maki",
  ]) {
    assert.ok(kinds.includes(k), `missing kind ${k}`);
  }
  assert.equal(new Set(kinds).size, 21, "kinds must be unique");
});

test("exactly the 15 session-reporting integrations can be sources", () => {
  assert.equal(agents.SOURCE_KINDS.size, 15);
  for (const k of [
    "claude",
    "codex",
    "copilot",
    "devin",
    "droid",
    "kimi",
    "omp",
    "mastracode",
    "pi",
    "hermes",
    "opencode",
    "qodercli",
    "kilo",
    "cursor",
    "agy",
  ]) {
    assert.ok(agents.SOURCE_KINDS.has(k), `${k} should be a source kind`);
  }
  for (const k of ["gemini", "cline", "kiro", "amp", "grok", "maki"]) {
    assert.ok(!agents.SOURCE_KINDS.has(k), `${k} must not be a source kind`);
  }
});

test("every agent has a friendly name, executable candidate, and explicit handoff permission mode", () => {
  for (const a of agents.AGENTS) {
    assert.ok(a.name && a.name.length > 0, `${a.kind} needs a name`);
    assert.ok(
      Array.isArray(a.exec) && a.exec.length > 0,
      `${a.kind} needs exec candidates`,
    );
    assert.ok(
      Array.isArray(a.yoloArgs),
      `${a.kind} needs explicit YOLO arguments`,
    );
  }
});

test("handoff YOLO arguments use each agent's documented CLI spelling", () => {
  const args = (kind) => agents.byKind(kind).yoloArgs;
  assert.deepEqual(args("claude"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(args("codex"), ["--yolo"]);
  // opencode's permissions already default to allow, so it needs no switch.
  assert.deepEqual(args("opencode"), []);
  assert.deepEqual(args("cline"), ["--auto-approve", "true", "--tui"]);
  assert.deepEqual(args("copilot"), ["--allow-all-tools"]);
  assert.deepEqual(args("cursor"), ["--yolo"]);
  assert.deepEqual(args("gemini"), ["--yolo"]);
  assert.deepEqual(args("pi"), []);
  assert.deepEqual(args("amp"), []);
  // Pi and OMP have no approval layer at all, so nothing to skip.
  assert.deepEqual(args("agy"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(args("devin"), ["--permission-mode", "yolo"]);
  assert.deepEqual(args("droid"), ["--skip-permissions-unsafe"]);
  assert.deepEqual(args("kilo"), ["--auto"]);
  // The rest of the startable roster runs in documented YOLO mode.
  for (const kind of [
    "grok",
    "hermes",
    "kimi",
    "kiro",
    "maki",
    "mastracode",
    "qodercli",
  ]) {
    assert.deepEqual(args(kind), ["--yolo"], `${kind} should run in YOLO mode`);
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

const posixOnly = {
  skip: process.platform === "win32" ? "POSIX-only behaviour" : false,
};

test(
  "resolveExecutable finds a symlinked executable on PATH",
  posixOnly,
  () => {
    const dir = tempPathDir(["claude-real"]);
    fs.symlinkSync("claude-real", path.join(dir, "claude"));

    const found = agents.resolveExecutable("claude", {
      PATH: dir,
      PATHEXT: "",
    });
    assert.equal(found, path.join(dir, "claude"));
  },
);

test(
  "resolveExecutable rejects a dangling executable symlink",
  posixOnly,
  () => {
    const dir = tempPathDir([]);
    fs.symlinkSync("missing-claude", path.join(dir, "claude"));
    const env = { PATH: dir, PATHEXT: "" };

    assert.equal(agents.resolveExecutable("claude", env), null);
    assert.ok(
      !agents.available(env).some((agent) => agent.kind === "claude"),
      "dangling claude symlink must not list claude",
    );
  },
);

test(
  "a symlinked shim validates node_modules relative to its target",
  posixOnly,
  () => {
    // The PATH entry is a symlink to a text shim elsewhere. The node_modules
    // reference inside the shim is relative to the real file, so validation
    // must resolve the link first.
    const target = path.join(
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-real-"));
    fs.mkdirSync(path.join(realDir, path.dirname(target)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(realDir, target), "#!/usr/bin/env node\n");
    fs.writeFileSync(
      path.join(realDir, "claude-real"),
      '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n',
      { mode: 0o755 },
    );
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-link-"));
    fs.symlinkSync(
      path.join(realDir, "claude-real"),
      path.join(linkDir, "claude"),
    );
    const env = { PATH: linkDir, PATHEXT: "" };
    assert.equal(
      agents.resolveExecutable("claude", env),
      path.join(linkDir, "claude"),
    );
  },
);

test(
  "a symlinked shim with a missing node_modules target is not installed",
  posixOnly,
  () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-real-"));
    fs.writeFileSync(
      path.join(realDir, "claude-real"),
      '#!/bin/sh\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n',
      { mode: 0o755 },
    );
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-link-"));
    fs.symlinkSync(
      path.join(realDir, "claude-real"),
      path.join(linkDir, "claude"),
    );
    const env = { PATH: linkDir, PATHEXT: "" };
    assert.equal(agents.resolveExecutable("claude", env), null);
    assert.ok(
      !agents.available(env).some((a) => a.kind === "claude"),
      "symlinked shim with missing target must not list claude",
    );
  },
);

test(
  "a dangling symlink with a binary extension is not installed",
  posixOnly,
  () => {
    // isLiveShim accepts .exe/.com by existence; a dangling link with that
    // extension must still be rejected since its target is gone. Looked up
    // by full filename because PATHEXT only applies on Windows.
    const dir = tempPathDir([]);
    fs.symlinkSync("missing-claude", path.join(dir, "claude.exe"));
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.CMD" };
    assert.equal(agents.resolveExecutable("claude.exe", env), null);
  },
);

test("a symlink to a directory is not an executable", posixOnly, () => {
  const dir = tempPathDir([]);
  fs.mkdirSync(path.join(dir, "real-dir"));
  fs.symlinkSync("real-dir", path.join(dir, "claude"));
  const env = { PATH: dir, PATHEXT: "" };
  assert.equal(agents.resolveExecutable("claude", env), null);
});

// PATHEXT resolution only applies on Windows, so these two are Windows-only.
const winOnly = {
  skip: process.platform !== "win32" ? "Windows-only behaviour" : false,
};

test(
  "resolveExecutable honours PATHEXT for Windows-style shims",
  winOnly,
  () => {
    const dir = tempPathDir(["claude.cmd"]);
    const found = agents.resolveExecutable("claude", {
      PATH: dir,
      PATHEXT: ".COM;.EXE;.CMD",
    });
    assert.equal(found, path.join(dir, "claude.cmd"));
  },
);

test(
  "resolveExecutable also matches .ps1 shims absent from PATHEXT",
  winOnly,
  () => {
    const dir = tempPathDir(["pi.ps1"]);
    const found = agents.resolveExecutable("pi", {
      PATH: dir,
      PATHEXT: ".COM;.EXE;.CMD",
    });
    assert.equal(found, path.join(dir, "pi.ps1"));
  },
);

test("resolveExecutable returns null when nothing matches", () => {
  const dir = tempPathDir([]);
  assert.equal(
    agents.resolveExecutable("claude", { PATH: dir, PATHEXT: "" }),
    null,
  );
});

// npm leaves launcher shims behind when a package is uninstalled; a shim whose
// node_modules target is gone must not count as installed. npm writes the same
// shape on every platform: a tiny text shim pointing into node_modules —
// claude.cmd on Windows, a bare `claude` shell script elsewhere.
function shimDir(target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-shim-"));
  const shimName = process.platform === "win32" ? "claude.cmd" : "claude";
  if (target) {
    fs.mkdirSync(path.join(dir, path.dirname(target)), { recursive: true });
    fs.writeFileSync(path.join(dir, target), "#!/usr/bin/env node\n");
  }
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(dir, shimName),
      `@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`,
    );
  } else {
    fs.writeFileSync(
      path.join(dir, shimName),
      '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"\n',
      { mode: 0o755 },
    );
  }
  return dir;
}

function shimEnv(dir) {
  return {
    PATH: dir,
    PATHEXT: process.platform === "win32" ? ".COM;.EXE;.CMD" : "",
  };
}

test("a dangling npm shim is not reported as installed", () => {
  const dir = shimDir(null); // the launcher exists, its cli.js target does not
  const env = shimEnv(dir);
  assert.equal(agents.resolveExecutable("claude", env), null);
  assert.ok(
    !agents.available(env).some((a) => a.kind === "claude"),
    "dangling claude shim must not list claude",
  );
});

test("a shim whose node_modules target exists is installed", () => {
  const dir = shimDir(
    path.join("node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  );
  const env = shimEnv(dir);
  assert.ok(
    agents.resolveExecutable("claude", env),
    "live shim should resolve",
  );
});

test("a real binary needs no shim validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-bin-"));
  const name = process.platform === "win32" ? "pi.exe" : "pi";
  const header =
    process.platform === "win32"
      ? Buffer.from([0x4d, 0x5a, 0x90, 0x00]) // MZ
      : Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // ELF magic
  fs.writeFileSync(path.join(dir, name), header);
  const env = shimEnv(dir);
  assert.ok(
    agents.resolveExecutable("pi", env),
    "a real binary is accepted by existence",
  );
});

test("available reflects the filesystem on every call, not a stale cache", () => {
  const dir = tempPathDir(["claude"]);
  const env = { PATH: dir, PATHEXT: "" };
  assert.deepEqual(
    agents.available(env).map((a) => a.kind),
    ["claude"],
  );
  fs.writeFileSync(path.join(dir, "cursor-agent"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  assert.deepEqual(
    agents
      .available(env)
      .map((a) => a.kind)
      .sort(),
    ["claude", "cursor"],
  );
});

test("available reports which executable candidate resolved", () => {
  const dir = tempPathDir(["cursor-agent"]);
  const cursor = agents
    .available({ PATH: dir, PATHEXT: "" })
    .find((a) => a.kind === "cursor");
  assert.equal(cursor.execName, "cursor-agent");
});

test("available reports only agents whose executable resolves, first candidate wins", () => {
  const dir = tempPathDir(["claude", "cursor-agent"]);
  const list = agents.available({ PATH: dir, PATHEXT: "" });
  const kinds = list.map((a) => a.kind);
  assert.deepEqual(kinds.sort(), ["claude", "cursor"]);
  assert.equal(
    list.find((a) => a.kind === "cursor").executable,
    path.join(dir, "cursor-agent"),
  );
});
