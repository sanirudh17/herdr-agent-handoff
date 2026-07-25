"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Display order: the agents most likely to be chosen first, then the rest
// alphabetically. Friendly names follow Herdr's integrations documentation.
const AGENTS = [
  { kind: "claude", name: "Claude Code", exec: ["claude"] },
  { kind: "codex", name: "Codex", exec: ["codex"] },
  { kind: "pi", name: "pi", exec: ["pi"] },
  { kind: "agy", name: "Antigravity CLI", exec: ["agy", "antigravity", "antigravity-cli"] },
  { kind: "amp", name: "Amp", exec: ["amp"] },
  { kind: "cline", name: "Cline", exec: ["cline"] },
  { kind: "copilot", name: "GitHub Copilot CLI", exec: ["copilot"] },
  { kind: "cursor", name: "Cursor Agent CLI", exec: ["cursor-agent", "cursor"] },
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
  "claude", "codex", "copilot", "devin", "droid", "kimi", "omp", "mastracode",
  "pi", "hermes", "opencode", "qodercli", "kilo", "cursor", "grok",
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

// Directory listings are cached for the life of the process. These are
// short-lived CLI invocations, so staleness is not a concern, and it keeps
// scanning a long PATH for 21 agents cheap.
const dirCache = new Map();

// Maps a lowercased filename to the real on-disk name. Windows filesystems are
// case-insensitive, so probing for "pi.PS1" would succeed while reporting a
// path that does not match the actual "pi.ps1" on disk.
function listDir(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  const entries = new Map();
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) entries.set(entry.name.toLowerCase(), entry.name);
    }
  } catch {
    // unreadable or missing PATH entry
  }
  dirCache.set(dir, entries);
  return entries;
}

function resolveExecutable(name, env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = extensionCandidates(env);
  for (const dir of dirs) {
    const entries = listDir(dir);
    for (const ext of exts) {
      const actual = entries.get((name + ext).toLowerCase());
      if (actual) return path.join(dir, actual);
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

module.exports = { AGENTS, TOTAL_COUNT, SOURCE_KINDS, byKind, resolveExecutable, available };
