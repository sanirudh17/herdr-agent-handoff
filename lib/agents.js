"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Display order: the agents most likely to be chosen first, then the rest
// alphabetically. Friendly names follow Herdr's integrations documentation.
// These are fixed, agent-owned arguments — never values supplied by the handoff
// prompt. Each agent CLI uses its own documented "skip all approval prompts"
// switch: `--dangerously-skip-permissions` (claude, agy), `--yolo` (codex,
// cursor, gemini, grok, hermes, kimi, kiro, maki, mastracode, qodercli),
// `--auto-approve true --tui` (cline), `--allow-all-tools` (copilot),
// `--permission-mode yolo` (devin), `--skip-permissions-unsafe` (droid), and
// `--auto` (kilo). Pi and OMP have no tool-approval layer, Amp is already
// approval-free by default, and opencode's permissions default to allow — so
// none of the four accepts (or needs) an extra switch.
const AGENTS = [
  {
    kind: "claude",
    name: "Claude Code",
    exec: ["claude"],
    yoloArgs: ["--dangerously-skip-permissions"],
  },
  { kind: "codex", name: "Codex", exec: ["codex"], yoloArgs: ["--yolo"] },
  { kind: "pi", name: "pi", exec: ["pi"], yoloArgs: [] },
  {
    kind: "agy",
    name: "Antigravity CLI",
    exec: ["agy", "antigravity", "antigravity-cli"],
    yoloArgs: ["--dangerously-skip-permissions"],
  },
  { kind: "amp", name: "Amp", exec: ["amp"], yoloArgs: [] },
  {
    kind: "cline",
    name: "Cline",
    exec: ["cline"],
    // Herdr's pane-shell launcher does not reliably make Cline infer a full TTY.
    // Without --tui Cline records interactive:false, creates a background session,
    // and never presents an input surface for the handoff prompt.
    yoloArgs: ["--auto-approve", "true", "--tui"],
  },
  {
    kind: "copilot",
    name: "GitHub Copilot CLI",
    exec: ["copilot"],
    yoloArgs: ["--allow-all-tools"],
  },
  {
    kind: "cursor",
    name: "Cursor Agent CLI",
    exec: ["cursor-agent", "cursor"],
    yoloArgs: ["--yolo"],
  },
  {
    kind: "devin",
    name: "Devin CLI",
    exec: ["devin"],
    yoloArgs: ["--permission-mode", "yolo"],
  },
  {
    kind: "droid",
    name: "Droid",
    exec: ["droid"],
    yoloArgs: ["--skip-permissions-unsafe"],
  },
  {
    kind: "gemini",
    name: "Gemini CLI (deprecated)",
    exec: ["gemini"],
    yoloArgs: ["--yolo"],
  },
  {
    kind: "grok",
    name: "Grok",
    exec: ["grok", "grok-build"],
    yoloArgs: ["--yolo"],
  },
  {
    kind: "hermes",
    name: "Hermes Agent",
    exec: ["hermes", "hermes-agent"],
    yoloArgs: ["--yolo"],
  },
  { kind: "kilo", name: "Kilo Code CLI", exec: ["kilo"], yoloArgs: ["--auto"] },
  { kind: "kimi", name: "Kimi Code CLI", exec: ["kimi"], yoloArgs: ["--yolo"] },
  { kind: "kiro", name: "Kiro", exec: ["kiro"], yoloArgs: ["--yolo"] },
  { kind: "maki", name: "Maki", exec: ["maki"], yoloArgs: ["--yolo"] },
  {
    kind: "mastracode",
    name: "MastraCode",
    exec: ["mastracode"],
    yoloArgs: ["--yolo"],
  },
  { kind: "omp", name: "OMP", exec: ["omp"], yoloArgs: [] },
  { kind: "opencode", name: "opencode", exec: ["opencode"], yoloArgs: [] },
  {
    kind: "qodercli",
    name: "Qoder CLI",
    exec: ["qodercli", "qoder"],
    yoloArgs: ["--yolo"],
  },
];

const TOTAL_COUNT = AGENTS.length;

// Mirrors Herdr's current direct-integration roster. Only these agents report a
// native session reference, so only these can be handoff sources. Screen-detected
// targets (including Grok) do not expose a source session identity.
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
  "agy",
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

// Maps a lowercased filename to the real on-disk name. Windows filesystems are
// case-insensitive, so probing for "pi.PS1" would succeed while reporting a path
// that does not match the actual "pi.ps1" on disk.
//
// The cache is scoped to one sweep, not to the process: `available()` reuses it
// across all 21 agents so a long PATH is read once, but a later call sees the
// filesystem as it is now rather than as it was.
function listDir(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  const entries = new Map();
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) entries.set(entry.name.toLowerCase(), entry.name);
    }
  } catch {
    // unreadable or missing PATH entry
  }
  cache.set(dir, entries);
  return entries;
}

// npm-style launchers are tiny text shims that point at a file under
// node_modules. When the package is uninstalled the shim can survive (npm does
// not always clean up), so the file exists on PATH but the agent is gone — a
// false positive that would offer a target that cannot start. A shim whose
// referenced target no longer exists is treated as not installed. Real binaries
// (.exe/.com) and scripts without a node_modules reference cannot be checked
// further and are accepted by existence.
function isLiveShim(file) {
  if (/[.](exe|com)$/i.test(file)) return true;
  let text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  const ref = text.match(/node_modules[\\/][^"'\s]+/);
  if (!ref) return true;
  const target = path.resolve(path.dirname(file), ref[0]);
  return fs.existsSync(target);
}

function resolveExecutable(name, env = process.env, cache = new Map()) {
  const dirs = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const exts = extensionCandidates(env);
  for (const dir of dirs) {
    const entries = listDir(dir, cache);
    for (const ext of exts) {
      const actual = entries.get((name + ext).toLowerCase());
      if (actual) {
        const full = path.join(dir, actual);
        if (isLiveShim(full)) return full;
      }
    }
  }
  return null;
}

function available(env = process.env) {
  const cache = new Map();
  const out = [];
  for (const agent of AGENTS) {
    for (const name of agent.exec) {
      const executable = resolveExecutable(name, env, cache);
      if (executable) {
        // execName is the candidate that actually resolved, which is what should
        // be typed to launch the agent — `cursor-agent` rather than `cursor`.
        out.push({ ...agent, execName: name, executable });
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
