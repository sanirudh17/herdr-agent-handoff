# Agent Handoff

[![tests](https://github.com/sanirudh17/herdr-agent-handoff/actions/workflows/test.yml/badge.svg)](https://github.com/sanirudh17/herdr-agent-handoff/actions/workflows/test.yml)
![herdr 0.7.5+](https://img.shields.io/badge/herdr-0.7.5%2B-8a2be2)
![platforms: Windows • macOS • Linux](https://img.shields.io/badge/platforms-Windows%20%E2%80%A2%20macOS%20%E2%80%A2%20Linux-informational)
![live tested: Windows](https://img.shields.io/badge/live%20tested-Windows-brightgreen)
![node 18+](https://img.shields.io/badge/node-18%2B-5fa04e)
![license MIT](https://img.shields.io/badge/license-MIT-blue)

Hand an in-progress task from the agent in your active pane to a **fresh session of another installed
agent**, carrying the complete source session with it. No summary, no truncated transcript, no
follow-up prompt to write.

- **`prefix+a`** — the new agent opens in a split beside the source
- **`prefix+shift+a`** — the new agent opens in a new tab in the same workspace

The source pane is never closed, interrupted, modified, or sent input.

The supplier list is computed by scanning `PATH` **and validating launchers** — an npm
shim whose `node_modules` target was deleted by an uninstall is not "installed" — so
leftover launcher files from an uninstalled package never appear in the picker.

```
  installed (5)        not installed (16)             5 / 21 available

 pi in w5:p1 · 112 lines  →  new tab in workspace 5

  ▸ Codex            codex
    pi               pi
    Antigravity CLI  agy
    Cline            cline
    opencode         opencode




  ↑↓ select · tab section                     ⏎ hand off   esc cancel
```

## Install

```bash
herdr plugin install sanirudh17/herdr-agent-handoff
herdr plugin action invoke agent-handoff.setup-keys
```

`setup-keys` backs up your `config.toml`, adds the two keybindings, and reloads. It won't overwrite
`prefix+a` or `prefix+shift+a` if you've already bound them — re-run with `--force`, or add them by
hand. (`prefix+h` was avoided on purpose: it's Herdr's default `focus_pane_left`.)

<details>
<summary>Manual keybindings, and local development</summary>

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

To work on the plugin, link a clone instead of installing:

```bash
herdr plugin link /path/to/herdr-agent-handoff
npm test                                   # 284 tests, node:test, no dependencies
node bin/handoff-split.js --dry-run        # resolve and build the prompt, create nothing
herdr plugin log list --plugin agent-handoff
```
</details>

## Requirements

- **Herdr** 0.7.5 or newer (protocol 17) — check with `herdr status`
- **Node.js** 18 or newer on `PATH`; 22.5+ only to hand off *from* opencode, whose store needs `node:sqlite`
- **One supported agent** running in the pane you hand off from — that's enough, since the source is
  always offered as a target too, as a fresh session of itself
- **No dependencies.** Nothing to compile, nothing downloaded at install

## How it works

Herdr stores no transcripts, and terminal scrollback isn't history. What Herdr does expose is a native
session reference for the focused pane, so the plugin resolves that to the agent's **own** session file
and delivers the whole handoff inside the prompt. **It writes no files.**

- **Session fits the prompt** → the transcript is embedded verbatim. Nothing on disk, nothing to read.
- **Session is too large** → the prompt names the source agent's own transcript with its line count and
  SHA-256 as of the handoff, plus ordered 1,200-line ranges to read. A 16 MB session becomes a
  4,000-character prompt.

Either way the prompt opens with *"You are taking over this session from **pi**"* and tells the target
to read the whole session first, treat it as history, check the workspace and prefer it where they
disagree, preserve uncommitted work, resume from the exact stopping point, and not redo finished work.

**If the complete session can't be obtained, the handoff doesn't start.** There's no fallback to a
truncated transcript, terminal output, a git diff, or a summary. The source pane is only ever read.

## Agent support

Any of the 21 agent kinds Herdr can start can be a **target**, if its binary is on your `PATH`.

**Sources** are the agents Herdr reports a session identity for — `claude`, `codex`, `pi`, `opencode`,
`agy`, plus the other official sources. When the native reference is missing or points at nothing (a
session too young to have a transcript, a reference gone stale after an in-agent `/resume`), the source
is re-resolved from its own store by the pane's working directory: pi, claude and cline keep
cwd-keyed transcripts, codex rollouts carry their cwd on the first line, grok indexes sessions by
cwd, and opencode's session table records the directory it ran in (newest activity wins). A store
with no unique match **fails closed** — nothing is ever guessed, and no target pane is
created until complete context exists. Sources that report no session identity and have no
recoverable store (`gemini`, `kiro`, `amp`, `maki`) still cannot be sources; they work fine as
targets. A source kind whose store is not configured fails with an honest reason naming the gap.

<details>
<summary>The full picture</summary>

| agent | store | recovery by pane cwd |
|---|---|---|
| `claude` | `~/.claude/projects/*/<id>.jsonl` | yes — single transcript per project directory |
| `codex` | `~/.codex/sessions/**/rollout-*-<id>.jsonl` | yes — first-line `payload.cwd`, unique newest |
| `pi` | `~/.pi/agent/sessions/**/*_<id>.jsonl` | yes — single transcript per session directory |
| `opencode` | `~/.local/share/opencode/opencode.db` (read-only SQLite) | yes — `session` table keyed by `directory` (newest unarchived, tie refuses to guess) |
| `cline` | (no Herdr session identity) | yes — `db/sessions.db` row keyed by `workspace_root`/`cwd`, transcript `<id>.messages.json` |
| `grok` | (no Herdr session identity) | yes — `session_search.sqlite` index keyed by cwd |

A note on **cline**: like pi, cline writes its transcript lazily — its core creates the
session file and database row inside the first turn, so a handoff fired before the first
exchange waits briefly and then explains that there is nothing persisted yet ("cline has no
persisted session for … yet; cline writes its transcript after the first exchange").

Supported with documented but untested store locations: `copilot`, `devin`, `droid`, `kimi`,
`qodercli`, `kilo`, `cursor`, `mastracode`, `hermes`, `omp`. Each is verified at runtime and fails hard
rather than degrading, so an untested resolver can never produce a partial transfer.

The handoff opens the picker even when the source context cannot be resolved yet; if it still cannot be
retrieved after you choose a target, the refusal says why (and a missing transcript is waited out
briefly — pi writes its session file only after the first assistant reply).

One exception to writing nothing: an opencode session too large to inline is exported to
`herdr-handoff-<session>.jsonl` beside `opencode.db`, overwritten each time. opencode keeps everything
in a single database with no per-session files, so above the budget there's nothing to point at.
</details>

## Platform support

The test suite (`node:test`, no dependencies) runs on Windows, macOS and Linux in CI. **Live handoffs
are verified on Windows**
(pi, Claude Code, Codex, Hermes, Grok); macOS and Linux haven't had a real handoff exercised yet, since
CI can't install Herdr or launch real agents. If you run it there, an
[issue](https://github.com/sanirudh17/herdr-agent-handoff/issues) either way is welcome.

<details>
<summary>Two known differences off Windows</summary>

- **YOLO-enabled agents are launched through their pane shell.** Herdr's documented `agent start`
  does not forward agent arguments, so a target that needs a permission-bypass switch is started from
  its pane shell on every platform. Targets that need no switch still use `agent start` where it works.
  Windows always uses the pane shell because Herdr renders an empty `-ArgumentList ''` for a no-argument
  target, which PowerShell rejects.
- **The prompt budget is sized for Windows.** 30,000 characters comes from Windows' 32,767-character
  command-line limit. macOS and Linux could inline much larger sessions, so handoffs there fall back to
  the file-reference mode sooner than they need to.

Failures are safe on every platform: the complete session is resolved *before* anything is created, and
the source pane is only ever read. The worst outcome is a message naming the step that failed, with your
original session untouched.
</details>

## Permissions on handoff

Targets start in their own unattended/YOLO mode, so a handoff does not stop at ordinary tool-approval
prompts. Each of the 21 startable kinds has an explicit launch policy — per-handoff only, the plugin
does not write or change any agent configuration files:

| agent | handoff launch |
|---|---|
| `claude` | `claude --dangerously-skip-permissions` |
| `codex` | `codex --yolo` (no sandbox, no approvals) |
| `pi` | `pi` — no built-in approval layer |
| `agy` | `agy --dangerously-skip-permissions` |
| `amp` | `amp` — approval-free by default |
| `cline` | `cline --auto-approve true` |
| `copilot` | `copilot --allow-all-tools` |
| `cursor` | `cursor-agent --yolo` |
| `devin` | `devin --permission-mode yolo` |
| `droid` | `droid --skip-permissions-unsafe` |
| `gemini` | `gemini --yolo` |
| `grok` | `grok --yolo` |
| `hermes` | `hermes --yolo` |
| `kilo` | `kilo --auto` (autonomous, no prompts) |
| `kimi` | `kimi --yolo` |
| `kiro` | `kiro --yolo` |
| `maki` | `maki --yolo` |
| `mastracode` | `mastracode --yolo` |
| `omp` | `omp` — no approval layer (Pi fork) |
| `opencode` | `opencode` — permissions already default to allow |
| `qodercli` | `qodercli --yolo` |

Account sign-in, OAuth, folder trust, and other startup dialogs are still never answered by the plugin.
They are not tool approvals and need the user's explicit action.

---

Design notes and the verified Herdr API findings this is built on:
[`docs/superpowers/specs/`](docs/superpowers/specs/). MIT licensed.
