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

```
Handoff to Agent                                              7 / 21 available

pi · w5:p1 · 112 lines  →  new tab in workspace 5

  ▸ Claude Code                   claude
    Codex                         codex
    pi                            pi            same agent, fresh session
    Antigravity CLI               agy
    Grok                          grok
    Hermes Agent                  hermes
    opencode                      opencode

  14 more supported agents not installed · ? to show

  ↑↓ move · 1-9 jump · enter select · esc cancel
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
npm test                                   # 260 tests, node:test, no dependencies
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

**Sources** are the 14 agents whose Herdr integration reports a session identity. Verified against real
session stores: `claude`, `codex`, `pi`, `opencode`.

<details>
<summary>The full picture</summary>

| agent | store |
|---|---|
| `claude` | `~/.claude/projects/*/<id>.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*-<id>.jsonl` |
| `pi` | `~/.pi/agent/sessions/**/*_<id>.jsonl` |
| `opencode` | `~/.local/share/opencode/opencode.db` (read-only SQLite) |

Supported with documented but untested store locations: `copilot`, `devin`, `droid`, `kimi`,
`qodercli`, `kilo`, `cursor`, `mastracode`, `hermes`, `omp`. Each is verified at runtime and fails hard
rather than degrading, so an untested resolver can never produce a partial transfer.

`gemini`, `agy`, `cline`, `grok`, `kiro`, `amp` and `maki` **cannot be sources** — their Herdr
integration reports no session identity, so the owning session could only be guessed. They work fine as
targets.

One exception to writing nothing: an opencode session too large to inline is exported to
`herdr-handoff-<session>.jsonl` beside `opencode.db`, overwritten each time. opencode keeps everything
in a single database with no per-session files, so above the budget there's nothing to point at.
</details>

## Platform support

The 260-test suite runs on Windows, macOS and Linux in CI. **Live handoffs are verified on Windows**
(pi, Claude Code, Codex, Hermes, Grok); macOS and Linux haven't had a real handoff exercised yet, since
CI can't install Herdr or launch real agents. If you run it there, an
[issue](https://github.com/sanirudh17/herdr-agent-handoff/issues) either way is welcome.

<details>
<summary>Two known differences off Windows</summary>

- **The agent is launched differently.** macOS and Linux use Herdr's documented `agent start`. Windows
  can't: Herdr renders the launch line with `-ArgumentList ''` for an agent that takes no arguments,
  which PowerShell rejects, so there the agent is started by typing at the pane's own shell.
- **The prompt budget is sized for Windows.** 30,000 characters comes from Windows' 32,767-character
  command-line limit. macOS and Linux could inline much larger sessions, so handoffs there fall back to
  the file-reference mode sooner than they need to.

Failures are safe on every platform: the complete session is resolved *before* anything is created, and
the source pane is only ever read. The worst outcome is a message naming the step that failed, with your
original session untouched.
</details>

---

Design notes and the verified Herdr API findings this is built on:
[`docs/superpowers/specs/`](docs/superpowers/specs/). MIT licensed.
