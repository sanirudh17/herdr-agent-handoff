# Agent Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Herdr plugin that transfers an in-progress session from the agent in the active pane to a fresh session of another installed Herdr-supported agent, delivering the complete native session context with no summary and no truncation.

**Architecture:** A plugin action (bound to a keybinding) orchestrates the handoff: it reads the source pane's native session reference, resolves it to the agent's own on-disk session store, opens a session-modal popup pane running a terminal picker, then creates the target pane/tab, starts the agent, and hands it a one-line prompt pointing at a read-only snapshot of the full session. All Herdr access goes through the Herdr CLI at `HERDR_BIN_PATH`. The action process orchestrates; the popup only picks.

**Tech Stack:** Node.js (CommonJS), zero runtime dependencies, `node:test` for tests, `node:sqlite` (feature-detected) for the opencode source only.

**Spec:** `docs/superpowers/specs/2026-07-25-agent-handoff-design.md`

## Global Constraints

- **Node ≥ 18** for everything; **Node ≥ 22.5** additionally required for opencode sources (`node:sqlite`), feature-detected at runtime.
- **Zero runtime dependencies.** `package.json` must have no `dependencies` and no `devDependencies`. No `[[build]]` commands in the manifest.
- **Cross-platform:** must work on `linux`, `macos`, `windows`. Use `node:path`, `os.homedir()`, and `path.delimiter`. Never hardcode `/` separators or POSIX-only paths.
- **All Herdr access via the CLI** at `process.env.HERDR_BIN_PATH` (falling back to `"herdr"`). Never open the API socket directly — the Windows socket is a named pipe requiring a `\\.\pipe\` prefix.
- **Never call `herdr pane read`** (or `pane.read`) anywhere in this codebase. Terminal scrollback is forbidden as a context source or fallback.
- **Plugin id:** `agent-handoff`. Action ids: `handoff-split`, `handoff-tab`, `setup-keys`. Pane entrypoint id: `picker`.
- **Keybindings:** `prefix+a` (split) and `prefix+shift+a` (new tab).
- **`min_herdr_version = "0.7.5"`.**
- **Herdr CLI output format** (verified): success is `{"id":"cli:...","result":{...}}` on stdout with exit 0; failure is `{"error":{"code":"...","message":"..."},"id":"cli:..."}` on stdout with exit 1.
- **User-facing message strings are exact.** Copy them verbatim from Task 11's `MESSAGES` table; do not reword.
- **Read-only toward the source.** The only call made against the source pane is `pane get`. Nothing sends it input, closes it, renames it, or moves its focus.

---

### Task 1: Project scaffold and plugin manifest

**Files:**

- Create: `package.json`
- Create: `herdr-plugin.toml`
- Create: `.gitignore`
- Create: `lib/paths.js`
- Test: `test/paths.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `lib/paths.js` exporting `stateDir(): string`, `configDir(): string`, `handoffsDir(): string`, `requestsDir(): string`. All return absolute paths and create nothing.

- [ ] **Step 1: Write the failing test**

Create `test/paths.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const paths = require("../lib/paths.js");

test("stateDir prefers HERDR_PLUGIN_STATE_DIR", () => {
  const dir = path.join(path.sep, "tmp", "state");
  assert.equal(paths.stateDir({ HERDR_PLUGIN_STATE_DIR: dir }), dir);
});

test("stateDir falls back to a cwd-relative dir when env is absent", () => {
  const got = paths.stateDir({});
  assert.ok(path.isAbsolute(got), `expected absolute path, got ${got}`);
});

test("handoffsDir and requestsDir sit under stateDir", () => {
  const dir = path.join(path.sep, "tmp", "state");
  const env = { HERDR_PLUGIN_STATE_DIR: dir };
  assert.equal(paths.handoffsDir(env), path.join(dir, "handoffs"));
  assert.equal(paths.requestsDir(env), path.join(dir, "requests"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../lib/paths.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/paths.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/paths.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Create the remaining scaffold files**

Create `package.json`:

```json
{
  "name": "herdr-agent-handoff",
  "version": "0.1.0",
  "private": true,
  "description": "Full-session ownership transfer between Herdr-supported coding agents",
  "license": "MIT",
  "scripts": {
    "test": "node --test test/"
  }
}
```

Create `.gitignore`:

```
node_modules/
.agent-handoff-state/
.agent-handoff-config/
*.log
```

Create `herdr-plugin.toml`:

```toml
id = "agent-handoff"
name = "Agent Handoff"
version = "0.1.0"
min_herdr_version = "0.7.5"
description = "Transfer an in-progress session to a fresh session of another installed agent"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "handoff-split"
title = "Handoff to agent (split)"
description = "Transfer the active agent session to a fresh agent beside it"
contexts = ["pane"]
command = ["node", "bin/handoff-split.js"]

[[actions]]
id = "handoff-tab"
title = "Handoff to agent (new tab)"
description = "Transfer the active agent session to a fresh agent in a new tab"
contexts = ["pane"]
command = ["node", "bin/handoff-tab.js"]

[[actions]]
id = "setup-keys"
title = "Install Agent Handoff keybindings"
description = "Add prefix+a and prefix+shift+a to config.toml"
contexts = ["global"]
command = ["node", "bin/setup-keys.js"]

[[panes]]
id = "picker"
title = "Handoff to Agent"
description = "Choose the agent to hand off to"
placement = "popup"
width = "70%"
height = "70%"
command = ["node", "bin/picker.js"]
```

Note: `contexts` values are restricted to `global | workspace | tab | pane | selection`, and `platforms` to `linux | macos | windows`. There is deliberately no `[[build]]` section — the plugin has no dependencies to install.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json herdr-plugin.toml .gitignore lib/paths.js test/paths.test.js
git commit -m "feat: scaffold agent-handoff plugin with manifest and path helpers"
```

---

### Task 2: Herdr CLI wrapper

**Files:**

- Create: `lib/herdr.js`
- Test: `test/herdr.test.js`
- Test fixture: `test/fixtures/fake-herdr.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `lib/herdr.js` exporting:
  - `class HerdrCliError extends Error` with fields `code: string|null`, `stderr: string`.
  - `binPath(env = process.env): string`
  - `run(args: string[], opts?: {json?: boolean, env?: object}): object|string` — returns the parsed `result` object when `json` is true (default), otherwise raw stdout. Throws `HerdrCliError` on non-zero exit, on an `error` envelope, or on unparseable output.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/fake-herdr.js` — a stand-in for the Herdr binary that echoes its argv back and can be told to fail:

```js
#!/usr/bin/env node
"use strict";

const args = process.argv.slice(2);

if (args[0] === "fail-envelope") {
  process.stdout.write(
    JSON.stringify({
      error: { code: "pane_not_found", message: "pane w99:p99 not found" },
      id: "cli:pane:get",
    }) + "\n",
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

if (args[0] === "plain") {
  process.stdout.write("Config: /home/u/.config/herdr/config.toml\n");
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({ id: "cli:test", result: { type: "echo", args } }) + "\n",
);
process.exit(0);
```

Create `test/herdr.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { run, binPath, HerdrCliError } = require("../lib/herdr.js");

const FAKE = path.join(__dirname, "fixtures", "fake-herdr.js");
// The fake is a .js file, so invoke node and let the first arg be the script.
const fakeEnv = { HERDR_BIN_PATH: process.execPath, HANDOFF_TEST_PREFIX: FAKE };

test("binPath falls back to herdr", () => {
  assert.equal(binPath({}), "herdr");
  assert.equal(binPath({ HERDR_BIN_PATH: "/opt/herdr" }), "/opt/herdr");
});

test("run returns the result payload and passes argv through", () => {
  const out = run([FAKE, "pane", "get", "w1:p1"], { env: fakeEnv });
  assert.equal(out.type, "echo");
  assert.deepEqual(out.args, ["pane", "get", "w1:p1"]);
});

test("run throws HerdrCliError carrying the envelope code and message", () => {
  assert.throws(
    () => run([FAKE, "fail-envelope"], { env: fakeEnv }),
    (err) => {
      assert.ok(err instanceof HerdrCliError);
      assert.equal(err.code, "pane_not_found");
      assert.match(err.message, /pane w99:p99 not found/);
      return true;
    },
  );
});

test("run throws on non-zero exit with unparseable output", () => {
  assert.throws(
    () => run([FAKE, "fail-garbage"], { env: fakeEnv }),
    HerdrCliError,
  );
});

test("run throws when json is expected but output is not JSON", () => {
  assert.throws(
    () => run([FAKE, "ok-garbage"], { env: fakeEnv }),
    HerdrCliError,
  );
});

test("run with json:false returns raw stdout", () => {
  const out = run([FAKE, "plain"], { env: fakeEnv, json: false });
  assert.match(out, /^Config: /);
});

test("run throws when the binary cannot be executed", () => {
  assert.throws(
    () =>
      run(["x"], {
        env: { HERDR_BIN_PATH: path.join(__dirname, "no-such-binary-xyz") },
      }),
    HerdrCliError,
  );
});
```

Note on the fake: the tests set `HERDR_BIN_PATH` to `process.execPath` (the node binary) and pass the fixture script path as the first element of `args`. `run` therefore needs no special test hooks — it just spawns `node <fixture> <rest>`. `HANDOFF_TEST_PREFIX` in `fakeEnv` is unused by the implementation and only documents intent.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/herdr.test.js`
Expected: FAIL — `Cannot find module '../lib/herdr.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/herdr.js`:

```js
"use strict";

const { spawnSync } = require("node:child_process");

class HerdrCliError extends Error {
  constructor(message, { code = null, stderr = "" } = {}) {
    super(message);
    this.name = "HerdrCliError";
    this.code = code;
    this.stderr = stderr;
  }
}

function binPath(env = process.env) {
  return env.HERDR_BIN_PATH || "herdr";
}

function lastJsonLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

function run(args, opts = {}) {
  const { json = true, env = process.env } = opts;
  const res = spawnSync(binPath(env), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  if (res.error) {
    throw new HerdrCliError(`could not run herdr: ${res.error.message}`);
  }

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  const envelope = lastJsonLine(stdout);

  if (envelope && envelope.error) {
    const { code = null, message = "herdr reported an error" } = envelope.error;
    throw new HerdrCliError(message, { code, stderr });
  }

  if (res.status !== 0) {
    throw new HerdrCliError(
      `herdr ${args.join(" ")} exited with status ${res.status}`,
      { stderr },
    );
  }

  if (!json) return stdout;

  if (!envelope || envelope.result === undefined) {
    throw new HerdrCliError(`herdr ${args.join(" ")} returned no JSON result`, {
      stderr,
    });
  }

  return envelope.result;
}

module.exports = { run, binPath, HerdrCliError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/herdr.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add lib/herdr.js test/herdr.test.js test/fixtures/fake-herdr.js
git commit -m "feat: add Herdr CLI wrapper with envelope error handling"
```

---

### Task 3: Agent registry and availability detection

**Files:**

- Create: `lib/agents.js`
- Test: `test/agents.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `lib/agents.js` exporting:
  - `AGENTS: Array<{kind: string, name: string, exec: string[]}>` — all 21 kinds, in display order.
  - `SOURCE_KINDS: Set<string>` — the 15 kinds that can be a handoff source.
  - `byKind(kind: string): object|undefined`
  - `resolveExecutable(name: string, env?: object): string|null`
  - `available(env?: object): Array<{kind, name, exec, executable}>`
  - `TOTAL_COUNT: number` — `AGENTS.length`, i.e. 21.

- [ ] **Step 1: Write the failing test**

Create `test/agents.test.js`:

```js
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

test("exactly the 15 integrated agents can be sources", () => {
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
    "grok",
  ]) {
    assert.ok(agents.SOURCE_KINDS.has(k), `${k} should be a source kind`);
  }
  for (const k of ["gemini", "agy", "cline", "kiro", "amp", "maki"]) {
    assert.ok(!agents.SOURCE_KINDS.has(k), `${k} must not be a source kind`);
  }
});

test("every agent has a friendly name and at least one executable candidate", () => {
  for (const a of agents.AGENTS) {
    assert.ok(a.name && a.name.length > 0, `${a.kind} needs a name`);
    assert.ok(
      Array.isArray(a.exec) && a.exec.length > 0,
      `${a.kind} needs exec candidates`,
    );
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agents.test.js`
Expected: FAIL — `Cannot find module '../lib/agents.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/agents.js`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Display order: the agents most likely to be chosen first, then the rest
// alphabetically. Friendly names follow Herdr's integrations documentation.
const AGENTS = [
  { kind: "claude", name: "Claude Code", exec: ["claude"] },
  { kind: "codex", name: "Codex", exec: ["codex"] },
  { kind: "pi", name: "pi", exec: ["pi"] },
  {
    kind: "agy",
    name: "Antigravity CLI",
    exec: ["agy", "antigravity", "antigravity-cli"],
  },
  { kind: "amp", name: "Amp", exec: ["amp"] },
  { kind: "cline", name: "Cline", exec: ["cline"] },
  { kind: "copilot", name: "GitHub Copilot CLI", exec: ["copilot"] },
  {
    kind: "cursor",
    name: "Cursor Agent CLI",
    exec: ["cursor-agent", "cursor"],
  },
  { kind: "devin", name: "Devin CLI", exec: ["devin"] },
  { kind: "droid", name: "Droid", exec: ["droid"] },
  { kind: "gemini", name: "Gemini CLI (deprecated)", exec: ["gemini"] },
  { kind: "grok", name: "Grok", exec: ["grok", "grok-build"] },
  { kind: "hermes", name: "Hermes Agent", exec: ["hermes", "hermes-agent"] },
  { kind: "kilo", name: "Kilo Code CLI", exec: ["kilo"] },
  { kind: "kimi", name: "Kimi Code CLI", exec: ["kimi"] },
  { kind: "kiro", name: "Kiro", exec: ["kiro"] },
  { kind: "maki", name: "Maki", exec: ["maki"] },
  { kind: "mastracode", name: "MastraCode", exec: ["mastracode"] },
  { kind: "omp", name: "OMP", exec: ["omp"] },
  { kind: "opencode", name: "opencode", exec: ["opencode"] },
  { kind: "qodercli", name: "Qoder CLI", exec: ["qodercli", "qoder"] },
];

const TOTAL_COUNT = AGENTS.length;

// Mirrors is_official_agent_source() in Herdr's src/agent_resume.rs. Only these
// agents ever report a native session reference, so only these can be sources.
const SOURCE_KINDS = new Set([
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
  "grok",
]);

function byKind(kind) {
  return AGENTS.find((a) => a.kind === kind);
}

function extensionCandidates(env) {
  if (process.platform !== "win32") return [""];
  const raw = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // npm installs .ps1 shims that PATHEXT usually omits; include them plus the
  // bare name so detection never produces a false negative.
  const all = [...raw, ".PS1", ""];
  const seen = new Set();
  return all.filter((ext) => {
    const key = ext.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveExecutable(name, env = process.env) {
  const dirs = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const exts = extensionCandidates(env);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not there; keep looking
      }
    }
  }
  return null;
}

function available(env = process.env) {
  const out = [];
  for (const agent of AGENTS) {
    for (const name of agent.exec) {
      const executable = resolveExecutable(name, env);
      if (executable) {
        out.push({ ...agent, executable });
        break;
      }
    }
  }
  return out;
}

module.exports = {
  AGENTS,
  TOTAL_COUNT,
  SOURCE_KINDS,
  byKind,
  resolveExecutable,
  available,
};
```

Note: `extensionCandidates` branches on `process.platform`, which is why the two shim tests above carry the `winOnly` skip — on POSIX the only candidate extension is `""`, so `claude.cmd` would never resolve for the name `claude`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/agents.test.js`
Expected: PASS — 9 tests (2 return early on non-Windows)

- [ ] **Step 5: Commit**

```bash
git add lib/agents.js test/agents.test.js
git commit -m "feat: add agent registry with cross-platform availability detection"
```

---

### Task 4: Source resolution — file strategy

**Files:**

- Create: `lib/sources.js`
- Test: `test/sources.test.js`

**Interfaces:**

- Consumes: `lib/agents.js` (`SOURCE_KINDS`).
- Produces: `lib/sources.js` exporting:
  - `class SourceContextUnavailable extends Error` with field `reason: string`.
  - `STORES: object` — keyed by agent kind.
  - `resolve({agent, sessionRef, env?, homedir?}): {strategy: "file", path: string, bytes: number, lines: number} | {strategy: "sqlite", dbPath: string, sessionId: string}`

  `sessionRef` is Herdr's `agent_session` object: `{kind: "id"|"path", value: string}`.

- [ ] **Step 1: Write the failing test**

Create `test/sources.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolve, SourceContextUnavailable } = require("../lib/sources.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-home-"));
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";
const BODY = '{"a":1}\n{"b":2}\n';

test("kind:path is used directly without searching", () => {
  const home = tmpHome();
  const file = writeFile(path.join(home, "anywhere", "session.jsonl"), BODY);
  const got = resolve({
    agent: "pi",
    sessionRef: { kind: "path", value: file },
    homedir: home,
    env: {},
  });
  assert.equal(got.strategy, "file");
  assert.equal(got.path, file);
  assert.equal(got.lines, 2);
  assert.equal(got.bytes, Buffer.byteLength(BODY));
});

test("claude resolves <id>.jsonl under any project directory", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(home, ".claude", "projects", "C--Users-x-proj", `${ID}.jsonl`),
    BODY,
  );
  const got = resolve({
    agent: "claude",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("claude honours CLAUDE_CONFIG_DIR", () => {
  const home = tmpHome();
  const alt = tmpHome();
  const file = writeFile(path.join(alt, "projects", "p", `${ID}.jsonl`), BODY);
  const got = resolve({
    agent: "claude",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: { CLAUDE_CONFIG_DIR: alt },
  });
  assert.equal(got.path, file);
});

test("codex resolves rollout-<date>-<id>.jsonl under nested date directories", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "07",
      "10",
      `rollout-2026-07-10T16-46-08-${ID}.jsonl`,
    ),
    BODY,
  );
  const got = resolve({
    agent: "codex",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("pi resolves <timestamp>_<id>.jsonl", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      "--C--proj--",
      `2026-07-24T17-10-59-546Z_${ID}.jsonl`,
    ),
    BODY,
  );
  const got = resolve({
    agent: "pi",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("grok resolves chat_history.jsonl inside a directory named for the session", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(
      home,
      ".grok",
      "sessions",
      "C%3A%5Cproj",
      ID,
      "chat_history.jsonl",
    ),
    BODY,
  );
  writeFile(
    path.join(
      home,
      ".grok",
      "sessions",
      "C%3A%5Cproj",
      ID,
      "announcement_state.json",
    ),
    "{}",
  );
  const got = resolve({
    agent: "grok",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("opencode returns a sqlite descriptor rather than a file", () => {
  const home = tmpHome();
  const db = writeFile(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    "x",
  );
  const got = resolve({
    agent: "opencode",
    sessionRef: { kind: "id", value: "ses_06af8a" },
    homedir: home,
    env: {},
  });
  assert.equal(got.strategy, "sqlite");
  assert.equal(got.dbPath, db);
  assert.equal(got.sessionId, "ses_06af8a");
});

test("non-integrated kinds are refused outright", () => {
  const home = tmpHome();
  for (const agent of ["gemini", "agy", "cline", "kiro", "amp", "maki"]) {
    assert.throws(
      () =>
        resolve({
          agent,
          sessionRef: { kind: "id", value: ID },
          homedir: home,
          env: {},
        }),
      (err) => {
        assert.ok(err instanceof SourceContextUnavailable);
        assert.match(err.reason, /no session identity/);
        return true;
      },
    );
  }
});

test("a missing session reference is refused", () => {
  const home = tmpHome();
  assert.throws(
    () =>
      resolve({ agent: "claude", sessionRef: null, homedir: home, env: {} }),
    SourceContextUnavailable,
  );
});

test("zero matches is a hard failure", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        homedir: home,
        env: {},
      }),
    SourceContextUnavailable,
  );
});

test("more than one match is a hard failure rather than a guess", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), BODY);
  writeFile(path.join(home, ".claude", "projects", "b", `${ID}.jsonl`), BODY);
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        homedir: home,
        env: {},
      }),
    (err) => {
      assert.match(err.reason, /more than one/);
      return true;
    },
  );
});

test("an empty transcript is a hard failure", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), "");
  assert.throws(
    () =>
      resolve({
        agent: "claude",
        sessionRef: { kind: "id", value: ID },
        homedir: home,
        env: {},
      }),
    SourceContextUnavailable,
  );
});

test("a kind:path value that does not exist is a hard failure", () => {
  const home = tmpHome();
  assert.throws(
    () =>
      resolve({
        agent: "pi",
        sessionRef: { kind: "path", value: path.join(home, "nope.jsonl") },
        homedir: home,
        env: {},
      }),
    SourceContextUnavailable,
  );
});

test("best-effort agents match any recognised extension containing the id", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(home, ".factory", "sessions", `conv-${ID}.json`),
    BODY,
  );
  const got = resolve({
    agent: "droid",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.path, file);
});

test("counts lines correctly when the file has no trailing newline", () => {
  const home = tmpHome();
  writeFile(
    path.join(home, ".claude", "projects", "a", `${ID}.jsonl`),
    '{"a":1}\n{"b":2}',
  );
  const got = resolve({
    agent: "claude",
    sessionRef: { kind: "id", value: ID },
    homedir: home,
    env: {},
  });
  assert.equal(got.lines, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sources.test.js`
Expected: FAIL — `Cannot find module '../lib/sources.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sources.js`:

```js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SOURCE_KINDS } = require("./agents.js");

const MAX_DEPTH = 6;
const MAX_ENTRIES = 20000;
const BEST_EFFORT_EXTENSIONS = new Set([".jsonl", ".json", ".md", ".log"]);

class SourceContextUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SourceContextUnavailable";
    this.reason = reason;
  }
}

const join = (...parts) => path.join(...parts);

// roots(homedir, env) -> candidate directories, first existing one wins.
// fileMatch(basename, id) -> true when the file is this session's transcript.
// dirMatch(basename, id)  -> true when the directory belongs to this session.
// dirFile(basename)       -> true for the transcript inside a matched directory.
const STORES = {
  claude: {
    strategy: "file",
    verified: true,
    roots: (home, env) => [
      env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "projects") : null,
      join(home, ".claude", "projects"),
    ],
    fileMatch: (base, id) => base === `${id}.jsonl`,
  },
  codex: {
    strategy: "file",
    verified: true,
    roots: (home, env) => [
      env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : null,
      join(home, ".codex", "sessions"),
    ],
    fileMatch: (base, id) =>
      base.startsWith("rollout-") && base.endsWith(`-${id}.jsonl`),
  },
  pi: {
    strategy: "file",
    verified: true,
    roots: (home) => [join(home, ".pi", "agent", "sessions")],
    fileMatch: (base, id) => base.endsWith(`_${id}.jsonl`),
  },
  grok: {
    strategy: "file",
    verified: true,
    roots: (home) => [join(home, ".grok", "sessions")],
    dirMatch: (base, id) => base === id,
    dirFile: (base) => base === "chat_history.jsonl",
  },
  opencode: {
    strategy: "sqlite",
    verified: true,
    dbPaths: (home, env) => [
      env.XDG_DATA_HOME
        ? join(env.XDG_DATA_HOME, "opencode", "opencode.db")
        : null,
      join(home, ".local", "share", "opencode", "opencode.db"),
      join(home, "Library", "Application Support", "opencode", "opencode.db"),
    ],
  },
  omp: {
    strategy: "file",
    roots: (home) => [join(home, ".omp", "agent", "sessions")],
  },
  copilot: { strategy: "file", roots: (home) => [join(home, ".copilot")] },
  devin: { strategy: "file", roots: (home) => [join(home, ".devin")] },
  droid: { strategy: "file", roots: (home) => [join(home, ".factory")] },
  kimi: { strategy: "file", roots: (home) => [join(home, ".kimi-code")] },
  qodercli: { strategy: "file", roots: (home) => [join(home, ".qoder")] },
  kilo: { strategy: "file", roots: (home) => [join(home, ".config", "kilo")] },
  cursor: { strategy: "file", roots: (home) => [join(home, ".cursor")] },
  mastracode: {
    strategy: "file",
    roots: (home) => [join(home, ".mastracode"), join(home, ".mastra")],
  },
  hermes: {
    strategy: "file",
    roots: (home) => [join(home, ".hermes", "sessions")],
  },
};

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  if (buffer[buffer.length - 1] !== 0x0a) count += 1;
  return count;
}

function describeFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new SourceContextUnavailable(`session file does not exist: ${file}`);
  }
  if (!stat.isFile())
    throw new SourceContextUnavailable(`session path is not a file: ${file}`);
  if (stat.size === 0)
    throw new SourceContextUnavailable(`session file is empty: ${file}`);
  const lines = countLines(fs.readFileSync(file));
  if (lines < 1)
    throw new SourceContextUnavailable(`session file has no lines: ${file}`);
  return { strategy: "file", path: file, bytes: stat.size, lines };
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function search(root, store, id) {
  const matches = [];
  let budget = MAX_ENTRIES;
  const bestEffort = store.verified !== true;

  const fileMatches = (base) => {
    if (store.fileMatch) return store.fileMatch(base, id);
    if (!bestEffort) return false;
    return (
      base.includes(id) &&
      BEST_EFFORT_EXTENSIONS.has(path.extname(base).toLowerCase())
    );
  };

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (store.dirMatch && store.dirMatch(entry.name, id)) {
          let inner;
          try {
            inner = fs.readdirSync(full, { withFileTypes: true });
          } catch {
            continue;
          }
          const picked = inner.filter(
            (e) =>
              e.isFile() &&
              (store.dirFile
                ? store.dirFile(e.name)
                : BEST_EFFORT_EXTENSIONS.has(
                    path.extname(e.name).toLowerCase(),
                  )),
          );
          for (const p of picked) matches.push(path.join(full, p.name));
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile() && fileMatches(entry.name)) {
        matches.push(full);
      }
    }
  };

  walk(root, 0);
  return matches;
}

function resolve({
  agent,
  sessionRef,
  env = process.env,
  homedir = os.homedir(),
}) {
  if (!SOURCE_KINDS.has(agent)) {
    throw new SourceContextUnavailable(
      `${agent} reports no session identity to Herdr, so it cannot be a handoff source`,
    );
  }

  const store = STORES[agent];
  if (!store) {
    throw new SourceContextUnavailable(
      `no session store is configured for ${agent}`,
    );
  }

  if (!sessionRef || !sessionRef.value) {
    throw new SourceContextUnavailable(
      `Herdr reported no session reference for ${agent}`,
    );
  }

  if (sessionRef.kind === "path") {
    return describeFile(sessionRef.value);
  }

  const id = sessionRef.value;

  if (store.strategy === "sqlite") {
    const dbPath = firstExisting(store.dbPaths(homedir, env));
    if (!dbPath) {
      throw new SourceContextUnavailable(`${agent} session database not found`);
    }
    return { strategy: "sqlite", dbPath, sessionId: id };
  }

  const root = firstExisting(store.roots(homedir, env));
  if (!root) {
    throw new SourceContextUnavailable(
      `${agent} session store directory not found`,
    );
  }

  const matches = search(root, store, id);
  if (matches.length === 0) {
    throw new SourceContextUnavailable(
      `no session file for ${agent} session ${id}`,
    );
  }
  if (matches.length > 1) {
    throw new SourceContextUnavailable(
      `more than one candidate session file for ${agent} session ${id}`,
    );
  }
  return describeFile(matches[0]);
}

module.exports = { resolve, countLines, STORES, SourceContextUnavailable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sources.test.js`
Expected: PASS — 15 tests

- [ ] **Step 5: Verify no scrollback path exists**

Run: `git grep -n "pane read\|pane_read\|pane\.read" -- lib bin || echo "clean"`
Expected: `clean`

- [ ] **Step 6: Commit**

```bash
git add lib/sources.js test/sources.test.js
git commit -m "feat: resolve native session transcripts with hard failure on ambiguity"
```

---

### Task 5: Source resolution — opencode SQLite strategy

**Files:**

- Create: `lib/source-sqlite.js`
- Test: `test/source-sqlite.test.js`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `lib/source-sqlite.js` exporting:
  - `class SqliteUnavailable extends Error`
  - `hasSqlite(): boolean`
  - `extract({dbPath, sessionId, workDir}): {jsonlPath: string, lines: number, bytes: number, counts: object}` — writes `<workDir>/opencode-session.jsonl` and returns its stats plus per-table row counts.

  Table order in the output is fixed: `session`, `message`, `part`, `session_message`, `todo`, `event`. Each line is `{"table": "<name>", "row": {...}}`.

- [ ] **Step 1: Write the failing test**

Create `test/source-sqlite.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  extract,
  hasSqlite,
  SqliteUnavailable,
} = require("../lib/source-sqlite.js");

const SKIP = !hasSqlite();
const SID = "ses_06af8a6fcffeIyWB7w5lX0xE7y";
const OTHER = "ses_ffffffffffffZZZZZZZZZZZZZZ";

function buildDb() {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-oc-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
      agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT, seq INTEGER);
    CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT,
      position INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?)").run(
    SID,
    "proj",
    "/w",
    "Fix the parser",
    "build",
    "opus",
    1,
    2,
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?)").run(
    OTHER,
    "proj",
    "/w",
    "Unrelated",
    "build",
    "opus",
    1,
    2,
  );
  // Insert out of chronological order to prove the exporter sorts.
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
    "m2",
    SID,
    20,
    20,
    '{"role":"assistant"}',
  );
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
    "m1",
    SID,
    10,
    10,
    '{"role":"user"}',
  );
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
    "mX",
    OTHER,
    10,
    10,
    '{"role":"user"}',
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
    "p2",
    "m1",
    SID,
    12,
    12,
    '{"type":"text","text":"beta"}',
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
    "p1",
    "m1",
    SID,
    11,
    11,
    '{"type":"text","text":"alpha"}',
  );
  db.prepare("INSERT INTO todo VALUES (?,?,?,?,?,?,?)").run(
    SID,
    "Ship it",
    "pending",
    "high",
    0,
    1,
    1,
  );
  db.prepare("INSERT INTO event VALUES (?,?,?,?,?)").run(
    "e1",
    SID,
    1,
    "message.updated.1",
    "{}",
  );
  db.close();
  return dbPath;
}

function readLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

test("hasSqlite reflects node:sqlite availability", () => {
  assert.equal(typeof hasSqlite(), "boolean");
});

test(
  "extract emits every row for the session in deterministic order",
  { skip: SKIP },
  () => {
    const dbPath = buildDb();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
    const out = extract({ dbPath, sessionId: SID, workDir });
    const rows = readLines(out.jsonlPath);

    assert.deepEqual(
      rows.map((r) => r.table),
      ["session", "message", "message", "part", "part", "todo", "event"],
    );
    assert.deepEqual(
      rows.filter((r) => r.table === "message").map((r) => r.row.id),
      ["m1", "m2"],
    );
    assert.deepEqual(
      rows.filter((r) => r.table === "part").map((r) => r.row.id),
      ["p1", "p2"],
    );
    assert.equal(out.lines, rows.length);
    assert.equal(out.counts.message, 2);
    assert.equal(out.counts.part, 2);
    assert.equal(out.counts.event, 1);
  },
);

test(
  "extract excludes rows belonging to other sessions",
  { skip: SKIP },
  () => {
    const dbPath = buildDb();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
    const out = extract({ dbPath, sessionId: SID, workDir });
    const body = fs.readFileSync(out.jsonlPath, "utf8");
    assert.ok(
      !body.includes(OTHER),
      "other session ids must not leak into the export",
    );
    assert.ok(!body.includes("Unrelated"));
  },
);

test("extract preserves data payloads byte-identically", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const out = extract({ dbPath, sessionId: SID, workDir });
  const parts = readLines(out.jsonlPath).filter((r) => r.table === "part");
  assert.equal(parts[0].row.data, '{"type":"text","text":"alpha"}');
  assert.equal(parts[1].row.data, '{"type":"text","text":"beta"}');
});

test("extract never opens the original database file", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  const before = fs.statSync(dbPath).mtimeMs;
  extract({ dbPath, sessionId: SID, workDir });
  assert.equal(
    fs.statSync(dbPath).mtimeMs,
    before,
    "source database must not be modified",
  );
  assert.ok(
    fs.existsSync(path.join(workDir, "opencode-copy.db")),
    "should work from a copy",
  );
});

test("extract rejects a session with no rows", { skip: SKIP }, () => {
  const dbPath = buildDb();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  assert.throws(
    () => extract({ dbPath, sessionId: "ses_missing", workDir }),
    /no opencode session/,
  );
});

test("extract rejects a session row with no messages", { skip: SKIP }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = buildDb();
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM message WHERE session_id = ?").run(SID);
  db.close();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
  assert.throws(
    () => extract({ dbPath, sessionId: SID, workDir }),
    /no messages/,
  );
});

test(
  "extract succeeds when the event log has been pruned",
  { skip: SKIP },
  () => {
    const { DatabaseSync } = require("node:sqlite");
    const dbPath = buildDb();
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM event WHERE aggregate_id = ?").run(SID);
    db.close();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
    const out = extract({ dbPath, sessionId: SID, workDir });
    assert.equal(out.counts.event, 0);
    assert.ok(out.lines > 0);
  },
);

test(
  "extract tolerates a database missing the newer tables",
  { skip: SKIP },
  () => {
    const { DatabaseSync } = require("node:sqlite");
    const dbPath = buildDb();
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE session_message; DROP TABLE todo;");
    db.close();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-work-"));
    const out = extract({ dbPath, sessionId: SID, workDir });
    assert.equal(out.counts.session_message, 0);
    assert.equal(out.counts.todo, 0);
  },
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/source-sqlite.test.js`
Expected: FAIL — `Cannot find module '../lib/source-sqlite.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/source-sqlite.js`:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class SqliteUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteUnavailable";
  }
}

function loadSqlite() {
  try {
    // node:sqlite landed in Node 22.5 and is unavailable on older runtimes.
    return require("node:sqlite");
  } catch {
    return null;
  }
}

function hasSqlite() {
  return loadSqlite() !== null;
}

// Fixed export order. `where` names the column holding the session id, and
// `order` is the deterministic sort applied within the table.
const TABLES = [
  { name: "session", where: "id", order: "id" },
  { name: "message", where: "session_id", order: "time_created, id" },
  { name: "part", where: "session_id", order: "message_id, time_created, id" },
  { name: "session_message", where: "session_id", order: "seq, id" },
  { name: "todo", where: "session_id", order: "position" },
  { name: "event", where: "aggregate_id", order: "seq" },
];

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function copyDatabase(dbPath, workDir) {
  const copy = path.join(workDir, "opencode-copy.db");
  fs.mkdirSync(workDir, { recursive: true });
  fs.copyFileSync(dbPath, copy);
  // opencode runs in WAL mode. Copying the sidecars lets SQLite recover a
  // consistent view from the copied WAL even while opencode holds the original.
  for (const suffix of ["-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, copy + suffix);
  }
  return copy;
}

function extract({ dbPath, sessionId, workDir }) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new SqliteUnavailable(
      "node:sqlite is unavailable; Node 22.5 or newer is required",
    );
  }

  const copy = copyDatabase(dbPath, workDir);
  const db = new sqlite.DatabaseSync(copy, { readOnly: true });
  const jsonlPath = path.join(workDir, "opencode-session.jsonl");
  const counts = {};
  const chunks = [];

  try {
    for (const table of TABLES) {
      if (!tableExists(db, table.name)) {
        counts[table.name] = 0;
        continue;
      }
      const rows = db
        .prepare(
          `SELECT * FROM "${table.name}" WHERE "${table.where}" = ? ORDER BY ${table.order}`,
        )
        .all(sessionId);
      counts[table.name] = rows.length;
      for (const row of rows) {
        chunks.push(JSON.stringify({ table: table.name, row }) + "\n");
      }
    }

    if (counts.session === 0) {
      throw new SqliteUnavailable(
        `no opencode session found for id ${sessionId}`,
      );
    }
    if (counts.message === 0) {
      throw new SqliteUnavailable(
        `opencode session ${sessionId} has no messages`,
      );
    }

    const body = Buffer.from(chunks.join(""), "utf8");
    fs.writeFileSync(jsonlPath, body);

    // Re-query after the export and assert nothing was dropped.
    const emitted = chunks.length;
    let recount = 0;
    for (const table of TABLES) {
      if (!tableExists(db, table.name)) continue;
      recount += db
        .prepare(
          `SELECT COUNT(*) AS c FROM "${table.name}" WHERE "${table.where}" = ?`,
        )
        .get(sessionId).c;
    }
    if (recount !== emitted) {
      throw new SqliteUnavailable(
        `opencode export is incomplete: emitted ${emitted} rows but the database holds ${recount}`,
      );
    }

    return { jsonlPath, lines: emitted, bytes: body.length, counts };
  } finally {
    db.close();
  }
}

module.exports = { extract, hasSqlite, SqliteUnavailable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/source-sqlite.test.js`
Expected: PASS — 9 tests (8 skip on Node < 22.5)

- [ ] **Step 5: Commit**

```bash
git add lib/source-sqlite.js test/source-sqlite.test.js
git commit -m "feat: extract complete opencode sessions from its SQLite store"
```

---

### Task 6: Snapshot writer

**Files:**

- Create: `lib/snapshot.js`
- Test: `test/snapshot.test.js`

**Interfaces:**

- Consumes: `lib/source-sqlite.js` (`extract`, `hasSqlite`, `SqliteUnavailable`), `lib/sources.js` (`countLines`).
- Produces: `lib/snapshot.js` exporting:
  - `chunk(buffer: Buffer, opts?: {maxLines?: number, maxBytes?: number}): Array<{buffer: Buffer, lines: number}>`
  - `write({resolved, meta, baseDir, now?}): {dir: string, parts: Array<{file: string, lines: number, firstLine: number, lastLine: number}>, totalLines: number, totalBytes: number, sha256: string, counts: object|null}`
  - `prune(baseDir: string, keep?: number): string[]` — returns the directories removed.

  `resolved` is the object from `sources.resolve`. `meta` carries `{sourceKind, sourceName, sessionId, sourcePaneId, workspaceId, tabId, cwd, destination, targetKind, targetName}`.

- [ ] **Step 1: Write the failing test**

Create `test/snapshot.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chunk, write, prune } = require("../lib/snapshot.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-snap-"));
}

const META = {
  sourceKind: "pi",
  sourceName: "pi",
  sessionId: "abc",
  sourcePaneId: "w5:p1",
  workspaceId: "w5",
  tabId: "w5:t1",
  cwd: "/w",
  destination: "tab",
  targetKind: "claude",
  targetName: "Claude Code",
};

test("chunk splits on line boundaries and reassembles byte-for-byte", () => {
  const body = Buffer.from("a\nb\nc\nd\ne\n");
  const parts = chunk(body, { maxLines: 2, maxBytes: 1024 });
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((p) => p.lines),
    [2, 2, 1],
  );
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk respects the byte cap even when the line cap is not reached", () => {
  const body = Buffer.from("aaaa\nbbbb\ncccc\n");
  const parts = chunk(body, { maxLines: 1000, maxBytes: 6 });
  assert.ok(parts.length >= 3);
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk handles a final line with no trailing newline", () => {
  const body = Buffer.from("a\nb");
  const parts = chunk(body, { maxLines: 1, maxBytes: 1024 });
  assert.deepEqual(
    parts.map((p) => p.lines),
    [1, 1],
  );
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk handles a single line", () => {
  const body = Buffer.from("only\n");
  const parts = chunk(body, { maxLines: 1200, maxBytes: 1024 });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].lines, 1);
});

test("chunk handles an exact boundary without emitting an empty part", () => {
  const body = Buffer.from("a\nb\n");
  const parts = chunk(body, { maxLines: 2, maxBytes: 1024 });
  assert.equal(parts.length, 1);
  assert.deepEqual(Buffer.concat(parts.map((p) => p.buffer)), body);
});

test("chunk returns nothing for an empty buffer", () => {
  assert.deepEqual(chunk(Buffer.alloc(0)), []);
});

test("write produces parts that reassemble into the original file", () => {
  const home = tmp();
  const src = path.join(home, "session.jsonl");
  const body =
    Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i })).join("\n") +
    "\n";
  fs.writeFileSync(src, body);

  const base = tmp();
  const out = write({
    resolved: {
      strategy: "file",
      path: src,
      bytes: Buffer.byteLength(body),
      lines: 3000,
    },
    meta: META,
    baseDir: base,
    now: new Date("2026-07-25T12:00:00Z"),
  });

  assert.ok(
    out.parts.length >= 3,
    "3000 lines should exceed one 1200-line part",
  );
  const joined = Buffer.concat(out.parts.map((p) => fs.readFileSync(p.file)));
  assert.deepEqual(joined, Buffer.from(body));
  assert.equal(out.totalLines, 3000);
  assert.equal(
    out.sha256,
    crypto.createHash("sha256").update(body).digest("hex"),
  );
});

test("write records contiguous part line ranges summing to the total", () => {
  const home = tmp();
  const src = path.join(home, "s.jsonl");
  const body =
    Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") + "\n";
  fs.writeFileSync(src, body);
  const base = tmp();
  const out = write({
    resolved: {
      strategy: "file",
      path: src,
      bytes: Buffer.byteLength(body),
      lines: 2500,
    },
    meta: META,
    baseDir: base,
  });

  let expected = 1;
  let sum = 0;
  for (const part of out.parts) {
    assert.equal(part.firstLine, expected);
    assert.equal(part.lastLine, expected + part.lines - 1);
    expected = part.lastLine + 1;
    sum += part.lines;
  }
  assert.equal(sum, out.totalLines);
});

test("write emits SOURCE.json with the metadata and part index", () => {
  const home = tmp();
  const src = path.join(home, "s.jsonl");
  fs.writeFileSync(src, "a\nb\n");
  const base = tmp();
  const out = write({
    resolved: { strategy: "file", path: src, bytes: 4, lines: 2 },
    meta: META,
    baseDir: base,
  });
  const source = JSON.parse(
    fs.readFileSync(path.join(out.dir, "SOURCE.json"), "utf8"),
  );
  assert.equal(source.source_agent, "pi");
  assert.equal(source.strategy, "file");
  assert.equal(source.native_path, src);
  assert.equal(source.total_lines, 2);
  assert.equal(source.parts.length, out.parts.length);
  assert.equal(source.source_pane_id, "w5:p1");
});

test("write marks the snapshot read-only", () => {
  const home = tmp();
  const src = path.join(home, "s.jsonl");
  fs.writeFileSync(src, "a\n");
  const base = tmp();
  const out = write({
    resolved: { strategy: "file", path: src, bytes: 2, lines: 1 },
    meta: META,
    baseDir: base,
  });
  if (process.platform !== "win32") {
    const mode = fs.statSync(out.parts[0].file).mode & 0o777;
    assert.equal(mode, 0o444);
  } else {
    assert.ok(fs.statSync(out.parts[0].file).size > 0);
  }
});

test("prune keeps the newest directories and removes the rest", () => {
  const base = tmp();
  for (const name of ["a", "b", "c", "d"]) {
    fs.mkdirSync(path.join(base, name), { recursive: true });
    fs.writeFileSync(path.join(base, name, "x"), "x");
  }
  const removed = prune(base, 2);
  assert.equal(removed.length, 2);
  assert.equal(fs.readdirSync(base).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/snapshot.test.js`
Expected: FAIL — `Cannot find module '../lib/snapshot.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/snapshot.js`:

```js
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { extract, hasSqlite, SqliteUnavailable } = require("./source-sqlite.js");

const MAX_LINES = 1200;
const MAX_BYTES = 256 * 1024;
const KEEP = 20;

function chunk(buffer, opts = {}) {
  const { maxLines = MAX_LINES, maxBytes = MAX_BYTES } = opts;
  if (buffer.length === 0) return [];

  const parts = [];
  let start = 0;
  let lines = 0;
  let cursor = 0;

  while (cursor < buffer.length) {
    const nl = buffer.indexOf(0x0a, cursor);
    const end = nl === -1 ? buffer.length : nl + 1;
    lines += 1;
    const wouldExceedBytes = end - start > maxBytes && lines > 1;

    if (wouldExceedBytes) {
      // Close the part before this line.
      parts.push({ buffer: buffer.subarray(start, cursor), lines: lines - 1 });
      start = cursor;
      lines = 1;
    }

    cursor = end;

    if (lines >= maxLines) {
      parts.push({ buffer: buffer.subarray(start, cursor), lines });
      start = cursor;
      lines = 0;
    }
  }

  if (start < buffer.length) {
    parts.push({ buffer: buffer.subarray(start), lines });
  }
  return parts;
}

function makeReadOnly(file) {
  try {
    // On Windows, Node maps the missing write bit to the ReadOnly attribute.
    fs.chmodSync(file, 0o444);
  } catch {
    // best effort; the briefing also tells the target not to write here
  }
}

function stamp(now) {
  return now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function write({ resolved, meta, baseDir, now = new Date() }) {
  const dir = path.join(
    baseDir,
    `${stamp(now)}-${meta.sourceKind}-to-${meta.targetKind}`,
  );
  const sessionDir = path.join(dir, "session");
  fs.mkdirSync(sessionDir, { recursive: true });

  let body;
  let counts = null;
  let nativePath = resolved.path || null;

  if (resolved.strategy === "sqlite") {
    if (!hasSqlite()) {
      throw new SqliteUnavailable(
        "node:sqlite is unavailable; Node 22.5 or newer is required",
      );
    }
    const exported = extract({
      dbPath: resolved.dbPath,
      sessionId: resolved.sessionId,
      workDir: dir,
    });
    body = fs.readFileSync(exported.jsonlPath);
    counts = exported.counts;
    nativePath = resolved.dbPath;
    fs.rmSync(exported.jsonlPath, { force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(path.join(dir, "opencode-copy.db" + suffix), { force: true });
    }
  } else {
    body = fs.readFileSync(resolved.path);
  }

  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const chunks = chunk(body);
  const parts = [];
  let cursorLine = 1;

  chunks.forEach((part, index) => {
    const name = `part-${String(index + 1).padStart(3, "0")}.jsonl`;
    const file = path.join(sessionDir, name);
    fs.writeFileSync(file, part.buffer);
    makeReadOnly(file);
    parts.push({
      file,
      name: path.join("session", name),
      lines: part.lines,
      bytes: part.buffer.length,
      firstLine: cursorLine,
      lastLine: cursorLine + part.lines - 1,
    });
    cursorLine += part.lines;
  });

  const totalLines = parts.reduce((sum, p) => sum + p.lines, 0);

  const sourceJson = {
    source_agent: meta.sourceKind,
    source_agent_name: meta.sourceName,
    session_id: meta.sessionId,
    strategy: resolved.strategy,
    native_path: nativePath,
    sha256,
    total_bytes: body.length,
    total_lines: totalLines,
    row_counts: counts,
    source_pane_id: meta.sourcePaneId,
    workspace_id: meta.workspaceId,
    tab_id: meta.tabId,
    cwd: meta.cwd,
    destination: meta.destination,
    target_agent: meta.targetKind,
    target_agent_name: meta.targetName,
    snapshot_utc: now.toISOString(),
    parts: parts.map((p) => ({
      name: p.name,
      lines: p.lines,
      bytes: p.bytes,
      first_line: p.firstLine,
      last_line: p.lastLine,
    })),
  };

  const sourceFile = path.join(dir, "SOURCE.json");
  fs.writeFileSync(sourceFile, JSON.stringify(sourceJson, null, 2) + "\n");
  makeReadOnly(sourceFile);

  return { dir, parts, totalLines, totalBytes: body.length, sha256, counts };
}

function prune(baseDir, keep = KEEP) {
  let entries;
  try {
    entries = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const sorted = entries
    .map((e) => ({ name: e.name, full: path.join(baseDir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const doomed = sorted.slice(0, Math.max(0, sorted.length - keep));
  const removed = [];
  for (const dir of doomed) {
    try {
      fs.rmSync(dir.full, { recursive: true, force: true });
      removed.push(dir.full);
    } catch {
      // leave it; pruning is best effort
    }
  }
  return removed;
}

module.exports = { chunk, write, prune, MAX_LINES, MAX_BYTES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/snapshot.test.js`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot.js test/snapshot.test.js
git commit -m "feat: snapshot sessions into verbatim read-only chunks with a part index"
```

---

### Task 7: Briefing generator

**Files:**

- Create: `lib/briefing.js`
- Test: `test/briefing.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `lib/briefing.js` exporting:
  - `render({snapshot, meta}): string` — the full `HANDOFF.md` text.
  - `kickoff({sourceName, handoffPath}): string` — the single-line prompt.

- [ ] **Step 1: Write the failing test**

Create `test/briefing.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { render, kickoff } = require("../lib/briefing.js");

const SNAPSHOT = {
  dir: "/state/handoffs/2026-07-25-pi-to-claude",
  totalLines: 4812,
  totalBytes: 862609,
  sha256: "deadbeef",
  counts: null,
  parts: [
    {
      name: "session/part-001.jsonl",
      lines: 1200,
      firstLine: 1,
      lastLine: 1200,
    },
    {
      name: "session/part-002.jsonl",
      lines: 1200,
      firstLine: 1201,
      lastLine: 2400,
    },
    {
      name: "session/part-003.jsonl",
      lines: 1200,
      firstLine: 2401,
      lastLine: 3600,
    },
    {
      name: "session/part-004.jsonl",
      lines: 1212,
      firstLine: 3601,
      lastLine: 4812,
    },
  ],
};

const META = {
  sourceKind: "pi",
  sourceName: "pi",
  sessionId: "abc",
  sourcePaneId: "w5:p1",
  workspaceId: "w5",
  tabId: "w5:t1",
  cwd: "/w/proj",
  destination: "tab",
  targetKind: "claude",
  targetName: "Claude Code",
  strategy: "file",
};

test("briefing states all six directives", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /read the complete source session/i);
  assert.match(text, /historical context/i);
  assert.match(text, /authoritative/i);
  assert.match(text, /uncommitted/i);
  assert.match(text, /exact stopping point/i);
  assert.match(text, /redo/i);
});

test("briefing lists every part with its line range and the totals", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  for (const part of SNAPSHOT.parts) {
    assert.ok(text.includes(part.name), `missing ${part.name}`);
    assert.ok(
      text.includes(`${part.firstLine}`),
      `missing first line ${part.firstLine}`,
    );
  }
  assert.ok(text.includes("4,812") || text.includes("4812"));
  assert.ok(text.includes("4 part"));
});

test("briefing forbids writing to the handoff directory and touching the source", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /read-only/i);
  assert.match(text, /w5:p1/);
  assert.match(text, /do not/i);
});

test("briefing covers non-coding work explicitly", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /notes|artifacts|conversation/i);
});

test("briefing names the source and target agents", () => {
  const text = render({ snapshot: SNAPSHOT, meta: META });
  assert.match(text, /\bpi\b/);
  assert.match(text, /Claude Code/);
});

test("briefing describes the sqlite export when that strategy was used", () => {
  const text = render({
    snapshot: {
      ...SNAPSHOT,
      counts: { session: 1, message: 12, part: 40, todo: 1, event: 135 },
    },
    meta: {
      ...META,
      sourceKind: "opencode",
      sourceName: "opencode",
      strategy: "sqlite",
    },
  });
  assert.match(text, /table/i);
  assert.match(text, /message/);
  assert.ok(text.includes("12"));
});

test("kickoff is a single line naming the briefing path", () => {
  const line = kickoff({
    sourceName: "pi",
    handoffPath: "/state/h/HANDOFF.md",
  });
  assert.ok(!line.includes("\n"), "kickoff must not contain newlines");
  assert.ok(!line.includes("\r"), "kickoff must not contain carriage returns");
  assert.match(line, /pi/);
  assert.match(line, /\/state\/h\/HANDOFF\.md/);
  assert.match(line, /before doing anything else/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/briefing.test.js`
Expected: FAIL — `Cannot find module '../lib/briefing.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/briefing.js`:

```js
"use strict";

const n = (value) => Number(value).toLocaleString("en-US");

function kickoff({ sourceName, handoffPath }) {
  return (
    `Session handoff from ${sourceName}. You now own this task. ` +
    `Read ${handoffPath} in full before doing anything else, then follow it exactly.`
  );
}

function partsTable(snapshot) {
  const rows = snapshot.parts
    .map(
      (p) =>
        `| \`${p.name}\` | ${n(p.lines)} | ${n(p.firstLine)}–${n(p.lastLine)} |`,
    )
    .join("\n");
  return ["| file | lines | line range |", "|---|---|---|", rows].join("\n");
}

function sqliteSection(snapshot) {
  const counts = snapshot.counts;
  if (!counts) return "";
  const rows = Object.keys(counts)
    .map((table) => `| \`${table}\` | ${n(counts[table])} |`)
    .join("\n");
  return [
    "",
    "### How to read this export",
    "",
    "This session came from a SQLite store, so each line is one database row shaped as",
    '`{"table": "<name>", "row": {...}}`. Rows appear in a fixed order: `session`, `message`,',
    "`part`, `session_message`, `todo`, then `event`. `message` and `part` carry the conversation;",
    "`part` holds the text, tool calls and tool results. `todo` is the task list as it stood at",
    "handoff. `event` is the append-only log behind the other tables and may be absent for older",
    "sessions. Every `data` field is the original payload, unmodified.",
    "",
    "| table | rows |",
    "|---|---|",
    rows,
  ].join("\n");
}

function render({ snapshot, meta }) {
  const handoffDir = snapshot.dir;
  const parts = snapshot.parts.length;

  return `# Session handoff — ${meta.sourceName} → ${meta.targetName}

You are taking over an in-progress session. The agent that started this work is
**${meta.sourceName}** (\`${meta.sourceKind}\`); you are **${meta.targetName}** (\`${meta.targetKind}\`).
Its complete session history is on disk beside this file. Nothing has been summarized, filtered, or
shortened.

| | |
|---|---|
| Source agent | ${meta.sourceName} (\`${meta.sourceKind}\`) |
| Source session | \`${meta.sessionId}\` |
| Source pane | \`${meta.sourcePaneId}\` (workspace \`${meta.workspaceId}\`, tab \`${meta.tabId}\`) |
| Working directory | \`${meta.cwd}\` |
| Captured at | ${snapshot.snapshotUtc || meta.snapshotUtc || "see SOURCE.json"} |
| Total | ${parts} part${parts === 1 ? "" : "s"}, ${n(snapshot.totalLines)} lines, ${n(snapshot.totalBytes)} bytes |

## Reading protocol — do this first

The history is split across **${parts} file${parts === 1 ? "" : "s"}** totalling
**${n(snapshot.totalLines)} lines**, only because a single file this size invites partial reads.
Read **every part, in order, start to finish** before you act. Do not sample it, do not skim it, and
do not stop early because a part looks repetitive.

${partsTable(snapshot)}

Paths are relative to \`${handoffDir}\`. \`SOURCE.json\` in the same directory records the byte size,
SHA-256 and line ranges if you want to confirm you have read all of it.
${sqliteSection(snapshot)}

## Your instructions

1. **Read the complete source session before acting.** Every part above, in order. Do not plan, edit,
   run commands, or answer until you have.
2. **Treat it as historical context.** It records what already happened. It is not a script to replay
   and its instructions were addressed to the previous agent, not to you.
3. **Inspect the current workspace, and let it win.** Check the actual state of the files, branch,
   processes, and any artifacts the session refers to. Where reality differs from the history, the
   workspace is authoritative — the history may simply be out of date.
4. **Preserve uncommitted work.** Treat everything in the working tree as deliberate. Never revert,
   reset, stash, discard, checkout over, or clean anything you did not create yourself.
5. **Continue from the exact stopping point.** Pick up the task in progress rather than restarting it
   or re-planning from scratch.
6. **Do not redo completed investigation.** Findings already established in the history stand unless
   the workspace contradicts them. Re-verify only what you have concrete reason to doubt.

## Scope of this handoff

This may be coding work or it may be research, analysis, writing, or plain conversation. If there is
no code involved, read "workspace" above as the files, notes, documents, and artifacts the session
referred to — the same rule applies: what is on disk now beats what the transcript says about it.

## Boundaries

- This directory is **read-only**. Do not modify, move, or delete anything under \`${handoffDir}\`.
- The source agent is still running in pane \`${meta.sourcePaneId}\`. Do not send it input, close it,
  interrupt it, or write to its session files. It has handed the task over; it is not a collaborator.
- You own this task now. Continue it yourself.
`;
}

module.exports = { render, kickoff, partsTable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/briefing.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add lib/briefing.js test/briefing.test.js
git commit -m "feat: generate the handoff briefing and single-line kickoff prompt"
```

---

### Task 8: Picker IPC

**Files:**

- Create: `lib/ipc.js`
- Test: `test/ipc.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `lib/ipc.js` exporting:
  - `newId(): string`
  - `requestPath(dir, id): string` and `resultPath(dir, id): string`
  - `writeJson(file, value): void` — atomic (temp file + rename).
  - `readJson(file): object`
  - `waitForResult(file, opts?: {timeoutMs?: number, pollMs?: number}): object|null` — returns `null` on timeout.
  - `cleanup(files: string[]): void`

- [ ] **Step 1: Write the failing test**

Create `test/ipc.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ipc = require("../lib/ipc.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-ipc-"));
}

test("newId produces unique filesystem-safe ids", () => {
  const a = ipc.newId();
  const b = ipc.newId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("request and result paths are derived from the id", () => {
  const dir = tmp();
  const id = "abc123";
  assert.equal(ipc.requestPath(dir, id), path.join(dir, "abc123.request.json"));
  assert.equal(ipc.resultPath(dir, id), path.join(dir, "abc123.result.json"));
});

test("writeJson then readJson round-trips and leaves no temp file", () => {
  const dir = tmp();
  const file = path.join(dir, "x.json");
  ipc.writeJson(file, { hello: "world", n: 1 });
  assert.deepEqual(ipc.readJson(file), { hello: "world", n: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["x.json"]);
});

test("waitForResult returns the payload once it appears", async () => {
  const dir = tmp();
  const file = path.join(dir, "r.json");
  setTimeout(() => ipc.writeJson(file, { selected: "claude" }), 40);
  const got = await ipc.waitForResult(file, { timeoutMs: 3000, pollMs: 10 });
  assert.deepEqual(got, { selected: "claude" });
});

test("waitForResult returns null on timeout", async () => {
  const dir = tmp();
  const got = await ipc.waitForResult(path.join(dir, "never.json"), {
    timeoutMs: 60,
    pollMs: 10,
  });
  assert.equal(got, null);
});

test("waitForResult ignores a partially written file until it parses", async () => {
  const dir = tmp();
  const file = path.join(dir, "r.json");
  fs.writeFileSync(file, '{"selected":');
  setTimeout(() => ipc.writeJson(file, { cancelled: true }), 60);
  const got = await ipc.waitForResult(file, { timeoutMs: 3000, pollMs: 10 });
  assert.deepEqual(got, { cancelled: true });
});

test("cleanup removes files and tolerates missing ones", () => {
  const dir = tmp();
  const file = path.join(dir, "a.json");
  ipc.writeJson(file, {});
  ipc.cleanup([file, path.join(dir, "gone.json")]);
  assert.equal(fs.existsSync(file), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ipc.test.js`
Expected: FAIL — `Cannot find module '../lib/ipc.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/ipc.js`:

```js
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function newId() {
  return crypto.randomBytes(9).toString("base64url");
}

function requestPath(dir, id) {
  return path.join(dir, `${id}.request.json`);
}

function resultPath(dir, id) {
  return path.join(dir, `${id}.result.json`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForResult(file, opts = {}) {
  const { timeoutMs = 300000, pollMs = 60 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return readJson(file);
    } catch {
      // absent or still being written
    }
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

function cleanup(files) {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
}

module.exports = {
  newId,
  requestPath,
  resultPath,
  writeJson,
  readJson,
  waitForResult,
  cleanup,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ipc.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add lib/ipc.js test/ipc.test.js
git commit -m "feat: add atomic request/result IPC between the action and the picker"
```

---

### Task 9: Picker UI primitives

**Files:**

- Create: `lib/ui.js`
- Test: `test/ui.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `lib/ui.js` exporting:
  - `decodeInput(buffer: Buffer): Array<{type: "key", name: string} | {type: "mouse", row: number, col: number}>` — mouse events are reported 0-indexed relative to the pane.
  - `initialState({title, available, unavailableCount, unavailable, contextLine, width, height}): object`
  - `applyKey(state, key: string): {state: object, action: null | {select: string} | {cancel: true}}`
  - `applyClick(state, row: number): {state: object, action: null | {select: string}}`
  - `renderFrame(state): string[]` — the lines to draw, no ANSI positioning.

- [ ] **Step 1: Write the failing test**

Create `test/ui.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../lib/ui.js");

const AVAILABLE = [
  { kind: "claude", name: "Claude Code" },
  { kind: "codex", name: "Codex" },
  { kind: "pi", name: "pi", isSource: true },
  { kind: "grok", name: "Grok" },
];

function state(overrides = {}) {
  return ui.initialState({
    title: "Handoff to Agent",
    contextLine: "pi · w5:p1 · 4,812 lines  →  new tab in workspace 5",
    available: AVAILABLE,
    unavailable: [{ kind: "gemini", name: "Gemini CLI (deprecated)" }],
    unavailableCount: 14,
    width: 78,
    height: 20,
    ...overrides,
  });
}

test("decodeInput maps arrows, vim keys, enter, escape and digits", () => {
  const seen = (buf) => ui.decodeInput(Buffer.from(buf)).map((e) => e.name);
  assert.deepEqual(seen("\x1b[A"), ["up"]);
  assert.deepEqual(seen("\x1b[B"), ["down"]);
  assert.deepEqual(seen("j"), ["j"]);
  assert.deepEqual(seen("k"), ["k"]);
  assert.deepEqual(seen("\r"), ["enter"]);
  assert.deepEqual(seen("\n"), ["enter"]);
  assert.deepEqual(seen("\x1b"), ["escape"]);
  assert.deepEqual(seen("q"), ["q"]);
  assert.deepEqual(seen("\x03"), ["ctrl-c"]);
  assert.deepEqual(seen("?"), ["?"]);
  assert.deepEqual(seen("3"), ["3"]);
});

test("decodeInput parses an SGR mouse press into zero-indexed coordinates", () => {
  const events = ui.decodeInput(Buffer.from("\x1b[<0;10;7M"));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "mouse");
  assert.equal(events[0].col, 9);
  assert.equal(events[0].row, 6);
});

test("decodeInput ignores mouse release events", () => {
  assert.deepEqual(ui.decodeInput(Buffer.from("\x1b[<0;10;7m")), []);
});

test("cursor starts on the first available agent", () => {
  assert.equal(state().cursor, 0);
});

test("down and up move the cursor and stop at the ends", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "down"));
  assert.equal(s.cursor, 1);
  ({ state: s } = ui.applyKey(s, "up"));
  assert.equal(s.cursor, 0);
  ({ state: s } = ui.applyKey(s, "up"));
  assert.equal(s.cursor, 0, "must not wrap past the top");
  for (let i = 0; i < 10; i += 1) ({ state: s } = ui.applyKey(s, "down"));
  assert.equal(s.cursor, AVAILABLE.length - 1, "must not wrap past the bottom");
});

test("enter selects the agent under the cursor", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "down"));
  const { action } = ui.applyKey(s, "enter");
  assert.deepEqual(action, { select: "codex" });
});

test("digits jump straight to an agent and select it", () => {
  const { action } = ui.applyKey(state(), "3");
  assert.deepEqual(action, { select: "pi" });
});

test("a digit beyond the list does nothing", () => {
  const { action } = ui.applyKey(state(), "9");
  assert.equal(action, null);
});

test("escape, q and ctrl-c cancel", () => {
  for (const key of ["escape", "q", "ctrl-c"]) {
    assert.deepEqual(ui.applyKey(state(), key).action, { cancel: true });
  }
});

test("? toggles the unavailable block without moving the cursor", () => {
  let s = state();
  assert.equal(s.showUnavailable, false);
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.showUnavailable, true);
  assert.equal(s.cursor, 0);
  ({ state: s } = ui.applyKey(s, "?"));
  assert.equal(s.showUnavailable, false);
});

test("clicking an agent row selects it", () => {
  const s = state();
  const frame = ui.renderFrame(s);
  const row = frame.findIndex((line) => line.includes("Codex"));
  assert.ok(row > 0, "Codex should be rendered");
  assert.deepEqual(ui.applyClick(s, row).action, { select: "codex" });
});

test("clicking a non-agent row does nothing", () => {
  const s = state();
  assert.equal(ui.applyClick(s, 0).action, null);
});

test("clicking inside the revealed unavailable block does nothing", () => {
  let s = state();
  ({ state: s } = ui.applyKey(s, "?"));
  const frame = ui.renderFrame(s);
  const row = frame.findIndex((line) => line.includes("Gemini"));
  assert.ok(row > 0);
  assert.equal(ui.applyClick(s, row).action, null);
});

test("frame shows the title, availability count, context line and footer", () => {
  const text = ui.renderFrame(state()).join("\n");
  assert.match(text, /Handoff to Agent/);
  assert.match(text, /4 \/ 18 available/);
  assert.match(text, /w5:p1/);
  assert.match(text, /14 more supported agents not installed/);
  assert.match(text, /enter select/);
  assert.match(text, /esc cancel/);
});

test("frame marks the source agent as a fresh session", () => {
  const text = ui.renderFrame(state()).join("\n");
  assert.match(text, /same agent, fresh session/);
});

test("frame marks the cursor row and only that row", () => {
  const marked = ui
    .renderFrame(state())
    .filter((l) => l.trimStart().startsWith("▸"));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /Claude Code/);
});

test("frame scrolls when the roster exceeds the viewport", () => {
  const many = Array.from({ length: 21 }, (_, i) => ({
    kind: `k${i}`,
    name: `Agent ${i}`,
  }));
  let s = state({
    available: many,
    height: 14,
    unavailableCount: 0,
    unavailable: [],
  });
  for (let i = 0; i < 20; i += 1) ({ state: s } = ui.applyKey(s, "down"));
  const text = ui.renderFrame(s).join("\n");
  assert.match(text, /Agent 20/, "cursor row must stay visible");
  assert.ok(ui.renderFrame(s).length <= 14, "frame must respect the height");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.js`
Expected: FAIL — `Cannot find module '../lib/ui.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/ui.js`:

```js
"use strict";

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

function decodeInput(buffer) {
  const events = [];
  let i = 0;
  const text = buffer.toString("binary");

  while (i < text.length) {
    const rest = text.slice(i);

    const mouse = rest.match(SGR_MOUSE);
    if (mouse) {
      i += mouse[0].length;
      if (mouse[4] === "M") {
        events.push({
          type: "mouse",
          button: Number(mouse[1]),
          col: Number(mouse[2]) - 1,
          row: Number(mouse[3]) - 1,
        });
      }
      continue;
    }

    if (rest.startsWith("\x1b[A")) {
      events.push({ type: "key", name: "up" });
      i += 3;
      continue;
    }
    if (rest.startsWith("\x1b[B")) {
      events.push({ type: "key", name: "down" });
      i += 3;
      continue;
    }
    if (rest.startsWith("\x1b[C")) {
      events.push({ type: "key", name: "right" });
      i += 3;
      continue;
    }
    if (rest.startsWith("\x1b[D")) {
      events.push({ type: "key", name: "left" });
      i += 3;
      continue;
    }

    const ch = text[i];
    i += 1;

    if (ch === "\x1b") {
      events.push({ type: "key", name: "escape" });
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      events.push({ type: "key", name: "enter" });
      continue;
    }
    if (ch === "\x03") {
      events.push({ type: "key", name: "ctrl-c" });
      continue;
    }
    if (ch === "\x7f") {
      events.push({ type: "key", name: "backspace" });
      continue;
    }
    if (ch >= " " && ch <= "~") {
      events.push({ type: "key", name: ch });
      continue;
    }
  }

  return events;
}

function initialState(opts) {
  const {
    title,
    contextLine,
    available,
    unavailable = [],
    unavailableCount = 0,
    width = 78,
    height = 20,
  } = opts;
  return {
    title,
    contextLine,
    available,
    unavailable,
    unavailableCount,
    width,
    height,
    cursor: 0,
    scrollTop: 0,
    showUnavailable: false,
  };
}

// Rows above the agent list: title, blank, context, blank.
const HEADER_ROWS = 4;
// Rows below: blank, hint line(s), blank, footer.
const FOOTER_ROWS = 4;

function viewportSize(state) {
  const extra = state.showUnavailable
    ? Math.min(state.unavailable.length, 6) + 1
    : 0;
  return Math.max(1, state.height - HEADER_ROWS - FOOTER_ROWS - extra);
}

function clampScroll(state) {
  const size = viewportSize(state);
  let scrollTop = state.scrollTop;
  if (state.cursor < scrollTop) scrollTop = state.cursor;
  if (state.cursor >= scrollTop + size) scrollTop = state.cursor - size + 1;
  scrollTop = Math.max(
    0,
    Math.min(scrollTop, Math.max(0, state.available.length - size)),
  );
  return { ...state, scrollTop };
}

function applyKey(state, key) {
  const last = state.available.length - 1;

  if (key === "escape" || key === "q" || key === "ctrl-c") {
    return { state, action: { cancel: true } };
  }

  if (key === "up" || key === "k") {
    return {
      state: clampScroll({ ...state, cursor: Math.max(0, state.cursor - 1) }),
      action: null,
    };
  }

  if (key === "down" || key === "j") {
    return {
      state: clampScroll({
        ...state,
        cursor: Math.min(last, state.cursor + 1),
      }),
      action: null,
    };
  }

  if (key === "enter") {
    const chosen = state.available[state.cursor];
    return { state, action: chosen ? { select: chosen.kind } : null };
  }

  if (key === "?") {
    return {
      state: clampScroll({ ...state, showUnavailable: !state.showUnavailable }),
      action: null,
    };
  }

  if (key >= "1" && key <= "9") {
    const index = Number(key) - 1;
    const chosen = state.available[index];
    return { state, action: chosen ? { select: chosen.kind } : null };
  }

  return { state, action: null };
}

function agentRowIndex(state) {
  // Maps a rendered row number to an index into state.available.
  const map = new Map();
  const size = viewportSize(state);
  const visible = state.available.slice(
    state.scrollTop,
    state.scrollTop + size,
  );
  visible.forEach((_, offset) => {
    map.set(HEADER_ROWS + offset, state.scrollTop + offset);
  });
  return map;
}

function applyClick(state, row) {
  const index = agentRowIndex(state).get(row);
  if (index === undefined) return { state, action: null };
  const chosen = state.available[index];
  if (!chosen) return { state, action: null };
  return {
    state: { ...state, cursor: index },
    action: { select: chosen.kind },
  };
}

function pad(text, width) {
  return text.length >= width
    ? text.slice(0, width)
    : text + " ".repeat(width - text.length);
}

function renderFrame(state) {
  const total = state.available.length + state.unavailableCount;
  const counter = `${state.available.length} / ${total} available`;
  const lines = [];

  lines.push(pad(state.title, state.width - counter.length) + counter);
  lines.push("");
  lines.push(state.contextLine);
  lines.push("");

  const size = viewportSize(state);
  const visible = state.available.slice(
    state.scrollTop,
    state.scrollTop + size,
  );
  for (const [offset, agent] of visible.entries()) {
    const index = state.scrollTop + offset;
    const marker = index === state.cursor ? "▸" : " ";
    const note = agent.isSource ? "same agent, fresh session" : "";
    lines.push(
      `  ${marker} ${pad(agent.name, 30)}${pad(agent.kind, 14)}${note}`.trimEnd(),
    );
  }

  lines.push("");

  if (state.showUnavailable) {
    lines.push("  not installed:");
    for (const agent of state.unavailable.slice(0, 6)) {
      lines.push(`      ${pad(agent.name, 30)}${agent.kind}`.trimEnd());
    }
  } else if (state.unavailableCount > 0) {
    lines.push(
      `  ${state.unavailableCount} more supported agents not installed · ? to show`,
    );
  } else {
    lines.push("");
  }

  lines.push("");
  lines.push("  ↑↓ move · 1-9 jump · enter select · esc cancel");

  return lines.slice(0, state.height);
}

module.exports = {
  decodeInput,
  initialState,
  applyKey,
  applyClick,
  renderFrame,
  viewportSize,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui.test.js`
Expected: PASS — 17 tests

- [ ] **Step 5: Commit**

```bash
git add lib/ui.js test/ui.test.js
git commit -m "feat: add picker UI reducer, input decoding and frame rendering"
```

---

### Task 10: Picker entrypoint

**Files:**

- Create: `bin/picker.js`
- Test: `test/picker.test.js`

**Interfaces:**

- Consumes: `lib/ui.js`, `lib/ipc.js`.
- Produces: `bin/picker.js` — reads the request file named by `HERDR_HANDOFF_REQUEST`, renders the modal, writes `{selected: kind}` or `{cancelled: true}` to the request's `result` path, and exits 0.
  Honours `HANDOFF_PICKER_HEADLESS=1`, in which case it does not touch the TTY, reads newline-separated key names from stdin, and prints each rendered frame to stdout separated by a `\f` form feed. This is the seam the tests drive.

  Request file shape:

  ```json
  {
    "resultPath": "/abs/path/id.result.json",
    "contextLine": "pi · w5:p1 · 4,812 lines  →  new tab in workspace 5",
    "available": [
      { "kind": "claude", "name": "Claude Code", "isSource": false }
    ],
    "unavailable": [{ "kind": "gemini", "name": "Gemini CLI (deprecated)" }],
    "unavailableCount": 14
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `test/picker.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PICKER = path.join(__dirname, "..", "bin", "picker.js");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-pick-"));
  const resultPath = path.join(dir, "r.result.json");
  const requestPath = path.join(dir, "r.request.json");
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      resultPath,
      contextLine: "pi · w5:p1 · 4,812 lines  →  split beside w5:p1",
      available: [
        { kind: "claude", name: "Claude Code", isSource: false },
        { kind: "codex", name: "Codex", isSource: false },
        { kind: "pi", name: "pi", isSource: true },
      ],
      unavailable: [{ kind: "gemini", name: "Gemini CLI (deprecated)" }],
      unavailableCount: 18,
    }),
  );
  return { dir, requestPath, resultPath };
}

function runPicker(requestPath, keys) {
  return spawnSync(process.execPath, [PICKER], {
    input: keys.join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      HERDR_HANDOFF_REQUEST: requestPath,
      HANDOFF_PICKER_HEADLESS: "1",
    },
  });
}

test("selecting with enter writes the chosen kind", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["down", "enter"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    selected: "codex",
  });
});

test("selecting the source agent is allowed", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["3"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    selected: "pi",
  });
});

test("escape writes a cancellation", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, ["escape"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    cancelled: true,
  });
});

test("stdin closing without a choice writes a cancellation", () => {
  const { requestPath, resultPath } = setup();
  const res = runPicker(requestPath, []);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    cancelled: true,
  });
});

test("the rendered frame contains the title and roster", () => {
  const { requestPath } = setup();
  const res = runPicker(requestPath, ["enter"]);
  assert.match(res.stdout, /Handoff to Agent/);
  assert.match(res.stdout, /Claude Code/);
  assert.match(res.stdout, /3 \/ 21 available/);
});

test("a missing request file exits non-zero", () => {
  const res = spawnSync(process.execPath, [PICKER], {
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      HERDR_HANDOFF_REQUEST: path.join(os.tmpdir(), "nope.json"),
      HANDOFF_PICKER_HEADLESS: "1",
    },
  });
  assert.notEqual(res.status, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/picker.test.js`
Expected: FAIL — picker.js does not exist, non-zero exit for every test

- [ ] **Step 3: Write minimal implementation**

Create `bin/picker.js`:

```js
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const ipc = require("../lib/ipc.js");
const ui = require("../lib/ui.js");

const HEADLESS = process.env.HANDOFF_PICKER_HEADLESS === "1";

function loadRequest() {
  const file = process.env.HERDR_HANDOFF_REQUEST;
  if (!file) throw new Error("HERDR_HANDOFF_REQUEST is not set");
  return { file, request: ipc.readJson(file) };
}

function buildState(request) {
  return ui.initialState({
    title: "Handoff to Agent",
    contextLine: request.contextLine,
    available: request.available,
    unavailable: request.unavailable || [],
    unavailableCount: request.unavailableCount || 0,
    width: HEADLESS ? 78 : Math.max(40, process.stdout.columns || 78),
    height: HEADLESS ? 20 : Math.max(12, process.stdout.rows || 20),
  });
}

function drawHeadless(state) {
  process.stdout.write(ui.renderFrame(state).join("\n") + "\n\f");
}

function draw(state) {
  const frame = ui.renderFrame(state);
  process.stdout.write("\x1b[H\x1b[2J" + frame.join("\r\n"));
}

function finish(resultPath, payload, teardown) {
  if (teardown) teardown();
  ipc.writeJson(resultPath, payload);
  process.exit(0);
}

function runHeadless(request) {
  let state = buildState(request);
  drawHeadless(state);
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    input = "";
  }
  for (const key of input
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean)) {
    const out = ui.applyKey(state, key);
    state = out.state;
    drawHeadless(state);
    if (out.action && out.action.select) {
      return finish(request.resultPath, { selected: out.action.select }, null);
    }
    if (out.action && out.action.cancel) {
      return finish(request.resultPath, { cancelled: true }, null);
    }
  }
  return finish(request.resultPath, { cancelled: true }, null);
}

function runInteractive(request) {
  let state = buildState(request);
  const { stdin, stdout } = process;

  // Alternate screen, hide cursor, enable SGR mouse reporting.
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  const teardown = () => {
    stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  draw(state);

  stdin.on("data", (buf) => {
    for (const event of ui.decodeInput(buf)) {
      const out =
        event.type === "mouse"
          ? ui.applyClick(state, event.row)
          : ui.applyKey(state, event.name);
      state = out.state;
      if (out.action && out.action.select) {
        finish(request.resultPath, { selected: out.action.select }, teardown);
        return;
      }
      if (out.action && out.action.cancel) {
        finish(request.resultPath, { cancelled: true }, teardown);
        return;
      }
    }
    draw(state);
  });

  stdin.on("end", () =>
    finish(request.resultPath, { cancelled: true }, teardown),
  );
  process.on("SIGINT", () =>
    finish(request.resultPath, { cancelled: true }, teardown),
  );
  process.on("SIGTERM", () =>
    finish(request.resultPath, { cancelled: true }, teardown),
  );
}

function main() {
  let loaded;
  try {
    loaded = loadRequest();
  } catch (err) {
    process.stderr.write(`agent-handoff picker: ${err.message}\n`);
    process.exit(1);
    return;
  }
  if (HEADLESS) runHeadless(loaded.request);
  else runInteractive(loaded.request);
}

main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/picker.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add bin/picker.js test/picker.test.js
git commit -m "feat: add the Handoff to Agent modal picker"
```

---

### Task 11: Handoff orchestrator

**Files:**

- Create: `lib/handoff.js`
- Create: `bin/handoff-split.js`
- Create: `bin/handoff-tab.js`
- Test: `test/handoff.test.js`

**Interfaces:**

- Consumes: `lib/herdr.js`, `lib/agents.js`, `lib/sources.js`, `lib/snapshot.js`, `lib/briefing.js`, `lib/ipc.js`, `lib/paths.js`.
- Produces: `lib/handoff.js` exporting:
  - `MESSAGES` — the exact user-facing strings.
  - `run({destination, env?, dryRun?, pickerTimeoutMs?}): Promise<{ok: boolean, message: string}>`

  `destination` is `"split"` or `"tab"`. `run` never throws for expected failures; it returns `{ok: false, message}` and shows a notification.

**Exact message strings** — copy verbatim, do not reword:

| key                        | text                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `notAgentPane`             | `Handoff unavailable: the active pane is not a running agent.`                                     |
| `noContext`                | `Full handoff unavailable: complete session context could not be retrieved for this source agent.` |
| `needsNode225`             | `Full handoff unavailable: reading opencode's session store requires Node 22.5 or newer.`          |
| `targetCreateFailed(dest)` | `Handoff failed: could not create the target ${dest}. Source pane untouched.`                      |
| `startFailed(name)`        | `Handoff failed: ${name} did not start. Source pane untouched.`                                    |
| `promptFailed(name)`       | `Handoff failed: ${name} started but did not accept the handoff. Source pane untouched.`           |
| `success(src, tgt, dest)`  | `Handoff started: ${src} → ${tgt} (${dest})`                                                       |

`dest` renders as `split` or `new tab`.

- [ ] **Step 1: Write the failing test**

Create `test/handoff.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, MESSAGES } = require("../lib/handoff.js");

const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";
const SCRIPT = path.join(__dirname, "fixtures", "fake-herdr-session.js");

function workspace({
  agent = "pi",
  sessionRef = { kind: "id", value: ID },
  lines = 3,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-run-"));
  const state = path.join(home, "state");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "codex", "pi"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  // pi transcript
  const body =
    Array.from({ length: lines }, (_, i) => JSON.stringify({ i })).join("\n") +
    "\n";
  const file = path.join(
    home,
    ".pi",
    "agent",
    "sessions",
    "p",
    `2026-07-24T00-00-00-000Z_${ID}.jsonl`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);

  const calls = path.join(home, "calls.jsonl");
  const env = {
    ...process.env,
    PATH: bin,
    PATHEXT: "",
    HOME: home,
    USERPROFILE: home,
    HERDR_BIN_PATH: process.execPath,
    HERDR_PLUGIN_STATE_DIR: state,
    HANDOFF_FAKE_SCRIPT: SCRIPT,
    HANDOFF_FAKE_CALLS: calls,
    HANDOFF_FAKE_AGENT: agent,
    HANDOFF_FAKE_SESSION: JSON.stringify(sessionRef),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_id: "w5:p1",
      workspace_id: "w5",
      tab_id: "w5:t1",
      focused_pane_agent: agent,
      focused_pane_cwd: home,
    }),
    HANDOFF_TEST_HOME: home,
  };
  return { home, env, calls, file };
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("dry run resolves and snapshots without creating panes", async () => {
  const { env, calls } = workspace();
  const out = await run({ destination: "tab", env, dryRun: true });
  assert.equal(out.ok, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    argv.some((a) => a.startsWith("pane get")),
    "should read the source pane",
  );
  assert.ok(
    !argv.some((a) => a.startsWith("pane split")),
    "must not split in dry run",
  );
  assert.ok(
    !argv.some((a) => a.startsWith("tab create")),
    "must not create a tab in dry run",
  );
  assert.ok(
    !argv.some((a) => a.startsWith("agent start")),
    "must not start an agent in dry run",
  );
});

test("dry run writes a complete snapshot and briefing", async () => {
  const { env } = workspace({ lines: 5 });
  const out = await run({ destination: "split", env, dryRun: true });
  const dir = out.handoffDir;
  assert.ok(fs.existsSync(path.join(dir, "HANDOFF.md")));
  assert.ok(fs.existsSync(path.join(dir, "SOURCE.json")));
  const source = JSON.parse(
    fs.readFileSync(path.join(dir, "SOURCE.json"), "utf8"),
  );
  assert.equal(source.total_lines, 5);
  const parts = fs.readdirSync(path.join(dir, "session"));
  const joined = Buffer.concat(
    parts.sort().map((p) => fs.readFileSync(path.join(dir, "session", p))),
  );
  assert.equal(joined.toString(), fs.readFileSync(source.native_path, "utf8"));
});

test("a pane with no agent fails before opening the picker", async () => {
  const { env, calls } = workspace({ agent: "" });
  const out = await run({ destination: "tab", env });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.notAgentPane);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    !argv.some((a) => a.startsWith("plugin pane open")),
    "picker must not open",
  );
});

test("an unresolvable source fails before opening the picker", async () => {
  const { env, calls } = workspace({ agent: "claude" });
  const out = await run({ destination: "tab", env });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.noContext);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    !argv.some((a) => a.startsWith("plugin pane open")),
    "picker must not open",
  );
});

test("a non-integrated source kind fails with the context message", async () => {
  const { env } = workspace({ agent: "agy", sessionRef: null });
  const out = await run({ destination: "tab", env });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.noContext);
});

test("cancelling the picker leaves nothing created and reports nothing", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "tab",
    env,
    pickerChoice: { cancelled: true },
  });
  assert.equal(out.ok, false);
  assert.equal(out.cancelled, true);
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(!argv.some((a) => a.startsWith("tab create")));
  assert.ok(!argv.some((a) => a.startsWith("notification show")));
});

test("split handoff splits beside the source, starts, prompts, focuses and notifies", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.message, "Handoff started: pi → Claude Code (split)");
  const argv = readCalls(calls).map((c) => c.join(" "));
  const order = [
    "pane split",
    "agent start",
    "agent prompt",
    "agent focus",
    "notification show",
  ];
  let cursor = -1;
  for (const step of order) {
    const at = argv.findIndex((a, i) => i > cursor && a.startsWith(step));
    assert.ok(
      at > cursor,
      `${step} must run after the previous step; got ${JSON.stringify(argv)}`,
    );
    cursor = at;
  }
  assert.ok(
    argv.some((a) => a.includes("--pane w5:p1") && a.startsWith("pane split")),
  );
  assert.ok(
    argv.some(
      (a) => a.startsWith("pane split") && a.includes("--direction right"),
    ),
  );
  assert.ok(
    argv.some((a) => a.startsWith("pane split") && a.includes("--no-focus")),
  );
});

test("tab handoff creates a tab in the source workspace and resolves its pane", async () => {
  const { env, calls } = workspace();
  const out = await run({
    destination: "tab",
    env,
    pickerChoice: { selected: "codex" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.message, "Handoff started: pi → Codex (new tab)");
  const argv = readCalls(calls).map((c) => c.join(" "));
  assert.ok(
    argv.some(
      (a) => a.startsWith("tab create") && a.includes("--workspace w5"),
    ),
  );
  assert.ok(
    argv.some((a) => a.startsWith("pane list")),
    "must resolve the new tab's pane",
  );
});

test("the source pane is only ever read", async () => {
  const { env, calls } = workspace();
  await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  for (const call of readCalls(calls)) {
    const text = call.join(" ");
    const touchesSource = text.includes("w5:p1");
    const isRead =
      text.startsWith("pane get") ||
      text.startsWith("pane split") ||
      text.startsWith("pane list");
    assert.ok(
      !touchesSource || isRead,
      `unexpected write to the source pane: ${text}`,
    );
    assert.ok(
      !text.startsWith("pane send-text"),
      "must never send text to a pane",
    );
    assert.ok(
      !text.startsWith("pane send-keys"),
      "must never send keys to a pane",
    );
    assert.ok(!text.startsWith("pane close"), "must never close a pane");
    assert.ok(!text.startsWith("pane read"), "must never read scrollback");
  }
});

test("the prompt is a single line pointing at HANDOFF.md", async () => {
  const { env, calls } = workspace();
  await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  const prompt = readCalls(calls).find(
    (c) => c[0] === "agent" && c[1] === "prompt",
  );
  assert.ok(prompt, "expected an agent prompt call");
  const text = prompt[3];
  assert.ok(!text.includes("\n"), "prompt must be one line");
  assert.match(text, /HANDOFF\.md/);
  assert.match(text, /^Session handoff from pi\./);
});

test("a failed target creation reports and creates no agent", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_FAIL = "pane split";
  const out = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.targetCreateFailed("split"));
  assert.ok(
    !readCalls(calls).some((c) => c[0] === "agent" && c[1] === "start"),
  );
});

test("a failed agent start reports and does not prompt", async () => {
  const { env, calls } = workspace();
  env.HANDOFF_FAKE_FAIL = "agent start";
  const out = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.startFailed("Claude Code"));
  assert.ok(
    !readCalls(calls).some((c) => c[0] === "agent" && c[1] === "prompt"),
  );
});

test("a failed prompt reports the prompt failure", async () => {
  const { env } = workspace();
  env.HANDOFF_FAKE_FAIL = "agent prompt";
  const out = await run({
    destination: "split",
    env,
    pickerChoice: { selected: "claude" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.message, MESSAGES.promptFailed("Claude Code"));
});

test("only installed agents are offered to the picker", async () => {
  const { env } = workspace();
  const out = await run({ destination: "tab", env, dryRun: true });
  assert.deepEqual(out.request.available.map((a) => a.kind).sort(), [
    "claude",
    "codex",
    "pi",
  ]);
  assert.equal(out.request.unavailableCount, 18);
  assert.equal(
    out.request.available.find((a) => a.kind === "pi").isSource,
    true,
  );
});
```

Create `test/fixtures/fake-herdr-session.js` — a Herdr stand-in that records argv and answers the calls the orchestrator makes:

```js
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const argv = process.argv.slice(2);
const callsFile = process.env.HANDOFF_FAKE_CALLS;
if (callsFile) fs.appendFileSync(callsFile, JSON.stringify(argv) + "\n");

const joined = argv.join(" ");
const fail = process.env.HANDOFF_FAKE_FAIL;
if (fail && joined.startsWith(fail)) {
  process.stdout.write(
    JSON.stringify({
      error: { code: "boom", message: `${fail} failed` },
      id: "cli:x",
    }) + "\n",
  );
  process.exit(1);
}

function ok(result) {
  process.stdout.write(JSON.stringify({ id: "cli:x", result }) + "\n");
  process.exit(0);
}

const agent = process.env.HANDOFF_FAKE_AGENT || "";
const sessionRaw = process.env.HANDOFF_FAKE_SESSION || "null";
const session = JSON.parse(sessionRaw);

if (argv[0] === "pane" && argv[1] === "get") {
  return ok({
    type: "pane_info",
    pane: {
      pane_id: "w5:p1",
      terminal_id: "t1",
      workspace_id: "w5",
      tab_id: "w5:t1",
      focused: true,
      agent_status: "idle",
      revision: 1,
      agent: agent || null,
      cwd: process.env.HANDOFF_TEST_HOME || process.cwd(),
      agent_session: session
        ? {
            agent,
            kind: session.kind,
            source: `herdr:${agent}`,
            value: session.value,
          }
        : null,
    },
  });
}

if (argv[0] === "pane" && argv[1] === "split") {
  return ok({
    type: "pane_info",
    pane: {
      pane_id: "w5:p2",
      terminal_id: "t2",
      workspace_id: "w5",
      tab_id: "w5:t1",
      focused: false,
      agent_status: "unknown",
      revision: 1,
    },
  });
}

if (argv[0] === "tab" && argv[1] === "create") {
  return ok({
    type: "tab_info",
    tab: {
      tab_id: "w5:t2",
      workspace_id: "w5",
      number: 2,
      label: "handoff",
      focused: false,
      pane_count: 1,
      agent_status: "unknown",
    },
  });
}

if (argv[0] === "pane" && argv[1] === "list") {
  return ok({
    type: "pane_list",
    panes: [
      {
        pane_id: "w5:p1",
        terminal_id: "t1",
        workspace_id: "w5",
        tab_id: "w5:t1",
        focused: true,
        agent_status: "idle",
        revision: 1,
      },
      {
        pane_id: "w5:p9",
        terminal_id: "t9",
        workspace_id: "w5",
        tab_id: "w5:t2",
        focused: false,
        agent_status: "unknown",
        revision: 1,
      },
    ],
  });
}

if (argv[0] === "agent" && argv[1] === "start") {
  return ok({
    type: "agent_started",
    argv: ["claude"],
    agent: {
      terminal_id: "t2",
      agent_status: "idle",
      workspace_id: "w5",
      tab_id: "w5:t1",
      pane_id: "w5:p2",
      focused: false,
      revision: 1,
      name: argv[2],
    },
  });
}

if (argv[0] === "agent" && argv[1] === "prompt")
  return ok({ type: "agent_prompted" });
if (argv[0] === "agent" && argv[1] === "focus")
  return ok({
    type: "agent_info",
    agent: {
      terminal_id: "t2",
      agent_status: "idle",
      workspace_id: "w5",
      tab_id: "w5:t1",
      pane_id: "w5:p2",
      focused: true,
      revision: 1,
    },
  });
if (argv[0] === "notification") return ok({ type: "notification_shown" });
if (argv[0] === "plugin")
  return ok({
    type: "plugin_pane_opened",
    plugin_pane: { plugin_id: "agent-handoff", entrypoint_id: "picker" },
  });

ok({ type: "unknown" });
```

Note on wiring: `HERDR_BIN_PATH` points at the node binary and `HANDOFF_FAKE_SCRIPT` at the fixture. `lib/handoff.js` must therefore prepend `env.HANDOFF_FAKE_SCRIPT` to every argv when that variable is set. Implement this as a tiny `cli()` helper inside `lib/handoff.js` — it is the single test seam and is inert in production because the variable is never set there.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.js`
Expected: FAIL — `Cannot find module '../lib/handoff.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/handoff.js`:

```js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agents = require("./agents.js");
const briefing = require("./briefing.js");
const herdr = require("./herdr.js");
const ipc = require("./ipc.js");
const paths = require("./paths.js");
const snapshot = require("./snapshot.js");
const sources = require("./sources.js");
const { SqliteUnavailable } = require("./source-sqlite.js");

const MESSAGES = {
  notAgentPane: "Handoff unavailable: the active pane is not a running agent.",
  noContext:
    "Full handoff unavailable: complete session context could not be retrieved for this source agent.",
  needsNode225:
    "Full handoff unavailable: reading opencode's session store requires Node 22.5 or newer.",
  targetCreateFailed: (dest) =>
    `Handoff failed: could not create the target ${dest}. Source pane untouched.`,
  startFailed: (name) =>
    `Handoff failed: ${name} did not start. Source pane untouched.`,
  promptFailed: (name) =>
    `Handoff failed: ${name} started but did not accept the handoff. Source pane untouched.`,
  success: (src, tgt, dest) => `Handoff started: ${src} → ${tgt} (${dest})`,
};

function cli(env) {
  const prefix = env.HANDOFF_FAKE_SCRIPT ? [env.HANDOFF_FAKE_SCRIPT] : [];
  return (args, opts = {}) => herdr.run([...prefix, ...args], { env, ...opts });
}

function notify(call, title) {
  try {
    call(["notification", "show", title]);
  } catch {
    // a failed toast must not mask the underlying outcome
  }
}

function context(env) {
  try {
    return JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function destLabel(destination) {
  return destination === "tab" ? "new tab" : "split";
}

function uniqueAgentName(call, kind) {
  let existing = [];
  try {
    const result = call(["agent", "list"]);
    existing = (result.agents || []).map((a) => a.name).filter(Boolean);
  } catch {
    existing = [];
  }
  const base = `handoff-${kind}`;
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now() % 1000}`;
}

async function run(opts) {
  const {
    destination,
    env = process.env,
    dryRun = false,
    pickerChoice = null,
    pickerTimeoutMs = 300000,
  } = opts;

  const call = cli(env);
  const ctx = context(env);
  const sourcePaneId = ctx.focused_pane_id;

  if (!sourcePaneId) {
    notify(call, MESSAGES.notAgentPane);
    return { ok: false, message: MESSAGES.notAgentPane };
  }

  // 1. Read the source pane. This is the only call made against it.
  let pane;
  try {
    pane = call(["pane", "get", sourcePaneId]).pane;
  } catch {
    notify(call, MESSAGES.notAgentPane);
    return { ok: false, message: MESSAGES.notAgentPane };
  }

  if (!pane.agent) {
    notify(call, MESSAGES.notAgentPane);
    return { ok: false, message: MESSAGES.notAgentPane };
  }

  const sourceKind = pane.agent;
  const sourceDef = agents.byKind(sourceKind);
  const sourceName = sourceDef ? sourceDef.name : sourceKind;
  const homedir = env.USERPROFILE || env.HOME || os.homedir();

  // 2. Resolve complete context BEFORE the picker opens.
  let resolved;
  try {
    resolved = sources.resolve({
      agent: sourceKind,
      sessionRef: pane.agent_session,
      env,
      homedir,
    });
  } catch {
    notify(call, MESSAGES.noContext);
    return { ok: false, message: MESSAGES.noContext };
  }

  // 3. Build the roster.
  const available = agents.available(env).map((a) => ({
    kind: a.kind,
    name: a.name,
    isSource: a.kind === sourceKind,
  }));
  const availableKinds = new Set(available.map((a) => a.kind));
  const unavailable = agents.AGENTS.filter(
    (a) => !availableKinds.has(a.kind),
  ).map((a) => ({
    kind: a.kind,
    name: a.name,
  }));

  const contextLine =
    `${sourceName} · ${sourcePaneId} · ${resolved.lines ? `${resolved.lines.toLocaleString("en-US")} lines` : "session store"}` +
    `  →  ${destination === "tab" ? `new tab in workspace ${pane.workspace_id}` : `split beside ${sourcePaneId}`}`;

  const requestsDir = paths.requestsDir(env);
  const id = ipc.newId();
  const requestFile = ipc.requestPath(requestsDir, id);
  const resultFile = ipc.resultPath(requestsDir, id);
  const request = {
    resultPath: resultFile,
    contextLine,
    available,
    unavailable,
    unavailableCount: unavailable.length,
  };

  const meta = {
    sourceKind,
    sourceName,
    sessionId: (pane.agent_session && pane.agent_session.value) || "",
    sourcePaneId,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    cwd: pane.cwd || ctx.focused_pane_cwd || homedir,
    destination,
    strategy: resolved.strategy,
  };

  // 4. Choose the target.
  let choice = pickerChoice;
  if (!choice && !dryRun) {
    ipc.writeJson(requestFile, request);
    try {
      call([
        "plugin",
        "pane",
        "open",
        "--plugin",
        "agent-handoff",
        "--entrypoint",
        "picker",
        "--env",
        `HERDR_HANDOFF_REQUEST=${requestFile}`,
        "--focus",
      ]);
    } catch {
      // Popup placement requires terminal mode; fall back to an overlay pane.
      // This is a UI fallback only and never changes what context is transferred.
      try {
        call([
          "plugin",
          "pane",
          "open",
          "--plugin",
          "agent-handoff",
          "--entrypoint",
          "picker",
          "--placement",
          "overlay",
          "--env",
          `HERDR_HANDOFF_REQUEST=${requestFile}`,
          "--focus",
        ]);
      } catch {
        ipc.cleanup([requestFile, resultFile]);
        notify(call, MESSAGES.targetCreateFailed(destLabel(destination)));
        return {
          ok: false,
          message: MESSAGES.targetCreateFailed(destLabel(destination)),
        };
      }
    }
    choice = await ipc.waitForResult(resultFile, {
      timeoutMs: pickerTimeoutMs,
    });
    ipc.cleanup([requestFile, resultFile]);
  }

  if (!dryRun) {
    if (!choice || choice.cancelled || !choice.selected) {
      return { ok: false, cancelled: true, message: "" };
    }
  }

  const targetKind = dryRun
    ? (choice && choice.selected) || sourceKind
    : choice.selected;
  const targetDef = agents.byKind(targetKind);
  const targetName = targetDef ? targetDef.name : targetKind;
  meta.targetKind = targetKind;
  meta.targetName = targetName;

  // 5. Snapshot the session.
  const handoffsDir = paths.handoffsDir(env);
  fs.mkdirSync(handoffsDir, { recursive: true });
  let snap;
  try {
    resolved = sources.resolve({
      agent: sourceKind,
      sessionRef: pane.agent_session,
      env,
      homedir,
    });
    snap = snapshot.write({ resolved, meta, baseDir: handoffsDir });
  } catch (err) {
    const message =
      err instanceof SqliteUnavailable && /node:sqlite/.test(err.message)
        ? MESSAGES.needsNode225
        : MESSAGES.noContext;
    notify(call, message);
    return { ok: false, message };
  }

  const handoffPath = path.join(snap.dir, "HANDOFF.md");
  fs.writeFileSync(
    handoffPath,
    briefing.render({
      snapshot: { ...snap, snapshotUtc: new Date().toISOString() },
      meta,
    }),
  );
  try {
    fs.chmodSync(handoffPath, 0o444);
  } catch {
    // best effort
  }
  snapshot.prune(handoffsDir);

  if (dryRun) {
    return { ok: true, message: "", handoffDir: snap.dir, request, meta };
  }

  // 6. Create the target.
  let targetPaneId;
  try {
    if (destination === "tab") {
      const tab = call([
        "tab",
        "create",
        "--workspace",
        pane.workspace_id,
        "--no-focus",
        "--cwd",
        meta.cwd,
      ]).tab;
      const panes = call(["pane", "list"]).panes || [];
      const found = panes.find((p) => p.tab_id === tab.tab_id);
      if (!found) throw new Error("new tab has no pane");
      targetPaneId = found.pane_id;
    } else {
      targetPaneId = call([
        "pane",
        "split",
        "--pane",
        sourcePaneId,
        "--direction",
        "right",
        "--no-focus",
        "--cwd",
        meta.cwd,
      ]).pane.pane_id;
    }
  } catch {
    const message = MESSAGES.targetCreateFailed(destLabel(destination));
    notify(call, message);
    return { ok: false, message };
  }

  // 7. Start the target agent.
  const agentName = uniqueAgentName(call, targetKind);
  try {
    call([
      "agent",
      "start",
      agentName,
      "--kind",
      targetKind,
      "--pane",
      targetPaneId,
      "--timeout",
      "60000",
    ]);
  } catch {
    const message = MESSAGES.startFailed(targetName);
    notify(call, message);
    return { ok: false, message };
  }

  // 8. Deliver the handoff.
  try {
    call([
      "agent",
      "prompt",
      agentName,
      briefing.kickoff({ sourceName, handoffPath }),
    ]);
  } catch {
    const message = MESSAGES.promptFailed(targetName);
    notify(call, message);
    return { ok: false, message };
  }

  // 9. Activate the target.
  try {
    call(["agent", "focus", agentName]);
  } catch {
    // the handoff already landed; focus is cosmetic
  }

  const message = MESSAGES.success(
    sourceName,
    targetName,
    destLabel(destination),
  );
  notify(call, message);
  return { ok: true, message, handoffDir: snap.dir, targetPaneId, agentName };
}

module.exports = { run, MESSAGES };
```

Create `bin/handoff-split.js`:

```js
#!/usr/bin/env node
"use strict";

const { run } = require("../lib/handoff.js");

run({ destination: "split", dryRun: process.argv.includes("--dry-run") })
  .then((out) => {
    if (out.message) process.stdout.write(out.message + "\n");
    process.exit(out.ok || out.cancelled ? 0 : 1);
  })
  .catch((err) => {
    process.stderr.write(`agent-handoff: ${err.stack || err.message}\n`);
    process.exit(1);
  });
```

Create `bin/handoff-tab.js`:

```js
#!/usr/bin/env node
"use strict";

const { run } = require("../lib/handoff.js");

run({ destination: "tab", dryRun: process.argv.includes("--dry-run") })
  .then((out) => {
    if (out.message) process.stdout.write(out.message + "\n");
    process.exit(out.ok || out.cancelled ? 0 : 1);
  })
  .catch((err) => {
    process.stderr.write(`agent-handoff: ${err.stack || err.message}\n`);
    process.exit(1);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/handoff.test.js`
Expected: PASS — 14 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/handoff.js bin/handoff-split.js bin/handoff-tab.js test/handoff.test.js test/fixtures/fake-herdr-session.js
git commit -m "feat: orchestrate the handoff from source resolution to target activation"
```

---

### Task 12: Keybinding installer

**Files:**

- Create: `lib/keybindings.js`
- Create: `bin/setup-keys.js`
- Test: `test/keybindings.test.js`

**Interfaces:**

- Consumes: `lib/herdr.js`.
- Produces: `lib/keybindings.js` exporting:
  - `BLOCKS: string` — the two `[[keys.command]]` blocks.
  - `KEYS: string[]` — `["prefix+a", "prefix+shift+a"]`.
  - `findConfigPath({env, helpOutput}): string|null`
  - `patch(text: string, opts?: {force?: boolean}): {text: string, changed: boolean, conflicts: string[]}`

- [ ] **Step 1: Write the failing test**

Create `test/keybindings.test.js`:

```js
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
  const existing =
    '[[keys.command]]\nkey = "prefix+shift+a"\ntype = "popup"\ncommand = "lazygit"\n';
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

test("findConfigPath prefers HERDR_CONFIG_PATH", () => {
  const p = path.join(path.sep, "custom", "config.toml");
  assert.equal(
    kb.findConfigPath({ env: { HERDR_CONFIG_PATH: p }, helpOutput: "" }),
    p,
  );
});

test("findConfigPath reads the Config line from herdr --help", () => {
  const p = path.join(path.sep, "home", "u", ".config", "herdr", "config.toml");
  const help = `Usage: herdr\n\nConfig: ${p}\nLogs:   /var/log/herdr.log\n`;
  assert.equal(kb.findConfigPath({ env: {}, helpOutput: help }), p);
});

test("findConfigPath falls back to the documented default", () => {
  const got = kb.findConfigPath({
    env: { HOME: path.join(path.sep, "h") },
    helpOutput: "",
  });
  assert.equal(
    got,
    path.join(path.sep, "h", ".config", "herdr", "config.toml"),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keybindings.test.js`
Expected: FAIL — `Cannot find module '../lib/keybindings.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/keybindings.js`:

```js
"use strict";

const path = require("node:path");

const KEYS = ["prefix+a", "prefix+shift+a"];
const ACTIONS = ["agent-handoff.handoff-split", "agent-handoff.handoff-tab"];

const BLOCKS = `
# Added by the Agent Handoff plugin.
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

// Locate any [[keys.command]] block that already targets one of our actions,
// so a re-run replaces it instead of appending a duplicate.
function stripOurBlocks(text) {
  const lines = text.split(/\r?\n/);
  const keep = [];
  let block = null;

  const flush = () => {
    if (!block) return;
    const isOurs = block.some((line) =>
      ACTIONS.some((action) => line.includes(`"${action}"`)),
    );
    if (!isOurs) keep.push(...block);
    block = null;
  };

  for (const line of lines) {
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

  return keep
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s*# Added by the Agent Handoff plugin\.\s*\n/, "\n");
}

function patch(text, opts = {}) {
  const { force = false } = opts;
  const original = text;
  const alreadyInstalled =
    ACTIONS.every((action) =>
      activeLines(text).some((line) => line.includes(`"${action}"`)),
    ) &&
    KEYS.every((key) =>
      activeLines(text).some((line) => line.includes(`"${key}"`)),
    );

  if (alreadyInstalled) {
    return { text: original, changed: false, conflicts: [] };
  }

  const cleaned = stripOurBlocks(text);
  const conflicts = [];
  for (const key of KEYS) {
    const bound = activeLines(cleaned).some((line) =>
      line.includes(`"${key}"`),
    );
    if (bound) conflicts.push(key);
  }

  if (conflicts.length > 0 && !force) {
    return { text: original, changed: false, conflicts };
  }

  const base = cleaned.replace(/\s*$/, "");
  const next =
    (base.length > 0 ? base + "\n" : "") + BLOCKS.replace(/^\n/, "\n");
  return { text: next.replace(/^\n+/, ""), changed: true, conflicts: [] };
}

module.exports = { BLOCKS, KEYS, ACTIONS, patch, findConfigPath };
```

Create `bin/setup-keys.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keybindings.test.js`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add lib/keybindings.js bin/setup-keys.js test/keybindings.test.js
git commit -m "feat: add opt-in keybinding installer with conflict detection"
```

---

### Task 13: README and live verification

**Files:**

- Create: `README.md`
- Test: manual, against the running Herdr session

**Interfaces:**

- Consumes: everything.
- Produces: documentation and a verified working plugin.

- [ ] **Step 1: Run the full suite and confirm it is green**

Run: `npm test`
Expected: PASS, all test files

- [ ] **Step 2: Confirm no forbidden scrollback path exists**

Run: `git grep -n "pane read\|pane_read\|pane\.read\|recent-unwrapped\|scrollback" -- lib bin || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Write the README**

Create `README.md`:

````markdown
# Agent Handoff

A Herdr plugin that transfers an in-progress task from the agent in the active pane to a **fresh
session of another installed agent**, carrying the complete source session with it. No summary, no
truncated transcript, no follow-up prompt to write.

`prefix+a` opens the picker and puts the new agent in a split beside the source.
`prefix+shift+a` puts it in a new tab in the same workspace.

The source pane is never closed, interrupted, modified, or sent input.

## Requirements

- Herdr 0.7.5 or newer
- Node.js 18 or newer on `PATH` (Node 22.5+ if you want to hand off _from_ opencode)

## Install

```bash
herdr plugin link /path/to/agent-handoff
herdr plugin action invoke agent-handoff.setup-keys
```
````

`setup-keys` backs up your `config.toml`, appends the two `[[keys.command]]` blocks, and reloads the
config. It refuses to overwrite `prefix+a` or `prefix+shift+a` if you have already bound them —
re-run with `--force` to override, or add the blocks yourself:

```toml
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
```

`prefix+h` was avoided deliberately: it is Herdr's default `focus_pane_left`.

## How it works

Herdr stores no transcripts, and its `pane read` sources are terminal scrollback — not history. What
Herdr does expose is a native session reference for the focused pane. This plugin resolves that
reference to the agent's **own** session store on disk, snapshots it read-only, and points the new
agent at it.

1. Read the source pane's agent kind and session reference (`pane get` — the only call made against
   the source).
2. Resolve the reference to the native session file, or the opencode database.
3. If that fails, stop. Nothing is created and you get an error.
4. Pick a target in the modal.
5. Snapshot the session verbatim into read-only, line-indexed chunks with a `SOURCE.json` manifest.
6. Create the split or tab, start the agent, and hand it a one-line prompt pointing at `HANDOFF.md`.
7. Focus the new pane and confirm: `Handoff started: pi → Claude Code (new tab)`.

`HANDOFF.md` instructs the target to read the whole session first, treat it as history, verify
against the current workspace and prefer it where they disagree, preserve uncommitted work, resume
from the exact stopping point, and not redo finished investigation.

## Agent support

Any of the 21 agent kinds Herdr can start may be a **target**, if its binary is on your `PATH`.

**Sources** are limited to the 15 agents that report a session identity to Herdr. Verified against
real session stores: `claude`, `codex`, `pi`, `grok`, `opencode`. Supported with documented but
untested store locations: `copilot`, `devin`, `droid`, `kimi`, `qodercli`, `kilo`, `cursor`,
`mastracode`, `hermes`, `omp`.

`gemini`, `agy`, `cline`, `kiro`, `amp` and `maki` **cannot be sources**: Herdr reports no session
identity for them, so the owning session could only be guessed. They work fine as targets.

## Failure behaviour

The handoff never degrades. If the complete session cannot be obtained, it does not start:

> Full handoff unavailable: complete session context could not be retrieved for this source agent.

There is no fallback to a truncated transcript, recent terminal output, a git diff, or a summary.
If the target fails to start or accept the handoff, you are told which step failed and the source is
left untouched.

## Development

```bash
npm test                                   # node:test, no dependencies
node bin/handoff-split.js --dry-run        # resolve + snapshot, create nothing
herdr plugin log list --plugin agent-handoff
```

````

- [ ] **Step 4: Link the plugin and confirm the manifest is accepted**

```bash
herdr plugin link .
herdr plugin list
herdr plugin action list --plugin agent-handoff
````

Expected: the plugin appears as `agent-handoff`, and all three actions (`handoff-split`,
`handoff-tab`, `setup-keys`) are listed. If the manifest is rejected, the error names the offending
field — fix it and re-link.

- [ ] **Step 5: Verify the dry run against the real session**

Focus a pane running a supported source agent, then run:

```bash
node bin/handoff-split.js --dry-run
```

Expected: exit 0, and a new directory under the plugin's state dir containing `HANDOFF.md`,
`SOURCE.json`, and `session/part-001.jsonl`. Confirm `SOURCE.json`'s `total_lines` matches the real
transcript:

```bash
herdr plugin config-dir agent-handoff   # locate the plugin's dirs
```

- [ ] **Step 6: Live smoke test — split**

Focus the source agent pane and press `prefix+a`. Choose Claude Code.

Verify: the modal is titled "Handoff to Agent"; only installed agents are listed; `?` reveals the
rest; a new pane appears to the right; Claude Code starts and begins by reading `HANDOFF.md`; the
toast reads `Handoff started: <source> → Claude Code (split)`; and the source pane is unchanged —
same scroll position, same state, no injected input.

- [ ] **Step 7: Live smoke test — new tab**

Press `prefix+shift+a` and choose a different agent. Verify the target lands in a new tab in the same
workspace, that tab is focused, and the source pane is again untouched.

- [ ] **Step 8: Live failure test**

Focus a plain shell pane (no agent) and press `prefix+a`.
Expected: the toast `Handoff unavailable: the active pane is not a running agent.` and no modal, no
new pane.

If an agent with no session integration is available (for example `agy`), start it and press
`prefix+a`.
Expected: `Full handoff unavailable: complete session context could not be retrieved for this source
agent.` and nothing created.

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs: document install, agent support and failure behaviour"
```

---

## Self-Review

**Spec coverage**

| Spec section                                       | Task                                 |
| -------------------------------------------------- | ------------------------------------ |
| §2.5 popup modal, manifest title                   | 1 (manifest), 9–10 (picker)          |
| §2.6 keybindings in config.toml                    | 1 (manifest actions), 12 (installer) |
| §2.8 CLI calls, §2.9 Windows socket avoidance      | 2                                    |
| §2.3/§2.4 source vs target kinds                   | 3                                    |
| §3, §3.1 file strategy resolvers                   | 4                                    |
| §3.2 opencode SQLite strategy                      | 5                                    |
| §8 context package, chunking, read-only, retention | 6                                    |
| §9 briefing and kickoff prompt                     | 7                                    |
| §7 step 6 picker IPC                               | 8                                    |
| §6 modal UX, keyboard and mouse                    | 9, 10                                |
| §7 orchestration, §10 error catalogue              | 11                                   |
| §5 setup-keys                                      | 12                                   |
| §11 live smoke tests, §12 limitations              | 13                                   |

**Type consistency check:** `sources.resolve` returns `{strategy, path, bytes, lines}` or
`{strategy, dbPath, sessionId}`; `snapshot.write` consumes exactly that shape as `resolved` and
returns `{dir, parts, totalLines, totalBytes, sha256, counts}`; `briefing.render` consumes that as
`snapshot` plus `meta`, and reads `parts[].name`, `parts[].lines`, `parts[].firstLine`,
`parts[].lastLine` — all produced by `snapshot.write`. `handoff.run` is the only caller of all three.
`MESSAGES` keys used in `lib/handoff.js` match those asserted in `test/handoff.test.js`.

**Known deviation from the spec's file list:** the spec's §4 layout did not include
`lib/keybindings.js` or `lib/paths.js`. Both were added to keep `bin/setup-keys.js` testable and to
give the state-directory layout a single owner. Everything else matches.
