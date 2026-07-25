# Agent Handoff

A Herdr plugin that transfers an in-progress task from the agent in the active pane to a **fresh
session of another installed agent**, carrying the complete source session with it. No summary, no
truncated transcript, no follow-up prompt to write.

`prefix+a` opens the picker and puts the new agent in a split beside the source.
`prefix+shift+a` puts it in a new tab in the same workspace.

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

## Requirements

- Herdr 0.7.5 or newer
- Node.js 18 or newer on `PATH` (Node 22.5+ if you want to hand off *from* opencode)

## Install

```bash
herdr plugin link /path/to/agent-handoff
herdr plugin action invoke agent-handoff.setup-keys
```

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
2. Resolve the reference to the native session file, or to the opencode database.
3. If that fails, stop. Nothing is created and you get an error.
4. Pick a target in the modal.
5. Snapshot the session verbatim into read-only, line-indexed chunks with a `SOURCE.json` manifest.
6. Create the split or tab, start the agent, and hand it a one-line prompt pointing at `HANDOFF.md`.
7. Focus the new pane and confirm: `Handoff started: pi → Claude Code (new tab)`.

`HANDOFF.md` instructs the target to read the whole session first, treat it as history, verify
against the current workspace and prefer it where they disagree, preserve uncommitted work, resume
from the exact stopping point, and not redo finished investigation.

The snapshot is chunked because sessions are large — 1.85 MB and 868 lines for a real Claude Code
session — and a single file that big invites an agent to read only part of it. `HANDOFF.md` states the
part count and total line count and requires reading every part in order.

## Agent support

Any of the 21 agent kinds Herdr can start may be a **target**, if its binary is on your `PATH`.

**Sources** are limited to the 15 agents that report a session identity to Herdr. Verified against
real session stores:

| agent | store |
|---|---|
| `claude` | `~/.claude/projects/*/<id>.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*-<id>.jsonl` |
| `pi` | `~/.pi/agent/sessions/**/*_<id>.jsonl` |
| `grok` | `~/.grok/sessions/*/<id>/chat_history.jsonl` |
| `opencode` | `~/.local/share/opencode/opencode.db` (read-only SQLite) |

Supported with documented but untested store locations: `copilot`, `devin`, `droid`, `kimi`,
`qodercli`, `kilo`, `cursor`, `mastracode`, `hermes`, `omp`. Each is verified at runtime and fails
hard rather than degrading, so an untested resolver can never produce a partial transfer.

`gemini`, `agy`, `cline`, `kiro`, `amp` and `maki` **cannot be sources**: Herdr's
`is_official_agent_source()` excludes them, so no session identity is reported and the owning session
could only be guessed. They work fine as targets. This matters most for `agy` — Gemini CLI was retired
on 2026-06-18 and Antigravity CLI is its successor, so an `agy` session integration is the most
valuable thing Herdr could add for this plugin.

## Failure behaviour

The handoff never degrades. If the complete session cannot be obtained, it does not start:

> Full handoff unavailable: complete session context could not be retrieved for this source agent.

There is no fallback to a truncated transcript, recent terminal output, a git diff, or a summary. The
**source** pane is only ever read through `pane get`; its scrollback is never touched, which the test
suite enforces. The **target's** screen is read once the handoff is sent, purely to confirm the prompt
arrived — some agents discard input until they have finished starting up, and the confirmation toast
is withheld until the prompt is actually visible rather than announced optimistically.

If the target fails to start or accept the handoff, you are told which step failed and the source is
left untouched. If you close the target while that confirmation is still in flight, nothing is
reported: the handoff worked and you moved on.

## Development

```bash
npm test                                   # 120 tests, node:test, no dependencies
node bin/handoff-split.js --dry-run        # resolve + snapshot, create nothing
herdr plugin log list --plugin agent-handoff
```

The design rationale, including the verified Herdr API findings this is built on, is in
`docs/superpowers/specs/2026-07-25-agent-handoff-design.md`.
