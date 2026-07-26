# Agent Handoff

[![tests](https://github.com/sanirudh17/herdr-agent-handoff/actions/workflows/test.yml/badge.svg)](https://github.com/sanirudh17/herdr-agent-handoff/actions/workflows/test.yml)

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
herdr plugin install sanirudh17/herdr-agent-handoff
herdr plugin action invoke agent-handoff.setup-keys
```

To work on it locally instead, link a clone:

```bash
herdr plugin link /path/to/herdr-agent-handoff
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
reference to the agent's **own** session store on disk and delivers the whole handoff inside the
prompt.

**The plugin writes no files.** There is no `HANDOFF.md`, no snapshot directory, no `SOURCE.json`, and
nothing to prune. One exception is documented below.

1. Read the source pane's agent kind and session reference (`pane get` — the only call made against
   the source).
2. Resolve the reference to the native session file, or to the opencode database.
3. If that fails, stop. Nothing is created and you get an error.
4. Pick a target in the modal.
5. Measure the session: byte count, line count, SHA-256. Nothing is copied.
6. Build one prompt from it, then create the split or tab, start the agent, and submit it.
7. Focus the new pane and confirm: `Handoff started: pi → Claude Code (new tab)`.

The prompt opens with *"You are taking over this session from **pi**"* and carries the instructions in
full: read the whole session first, treat it as history, verify against the current workspace and
prefer it where they disagree, preserve uncommitted work, resume from the exact stopping point, and do
not redo finished investigation.

### Two modes, chosen by size

`herdr agent prompt` takes its text as a command-line argument, so the whole prompt has to fit inside
Windows' 32,767-character limit — measured: 32,000 characters reach the server and 40,000 fail with
`ENAMETOOLONG`. The budget is 30,000, and the mode is decided by building the prompt and measuring it
rather than by estimating.

**Inline.** A session that fits is embedded in the prompt verbatim. Nothing is written, nothing is
read, and no permission dialog appears.

**Reference.** A larger session stays where it is. The prompt names the source agent's own transcript,
its **line count and SHA-256 as of the handoff**, and the ordered 1,200-line ranges to read — the same
protection the old chunk files gave, as instructions instead of copies. The target is told not to read
past the pinned last line, because that file is still live and its own agent may append to it.

Reference mode names a path outside your project, so some agents will ask permission to read it. Allow
it once, or run the agent in a permissive mode.

### The one exception

An opencode session too large to inline is exported to `herdr-handoff-<session>.jsonl` beside
`opencode.db`, overwritten on each handoff of that session so it never accumulates. opencode stores
everything in a single database — 304 MiB on the machine this was built on — with no per-session
files, so above the budget there is nothing to point a target at.

## Agent support

Any of the 21 agent kinds Herdr can start may be a **target**, if its binary is on your `PATH`.

**Sources** are limited to the 14 agents whose Herdr integrations report a session identity.
The source integration must be installed before its session can be handed off. Verified against real
session stores:

| agent | store |
|---|---|
| `claude` | `~/.claude/projects/*/<id>.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*-<id>.jsonl` |
| `pi` | `~/.pi/agent/sessions/**/*_<id>.jsonl` |
| `opencode` | `~/.local/share/opencode/opencode.db` (read-only SQLite) |

Supported with documented but untested store locations: `copilot`, `devin`, `droid`, `kimi`,
`qodercli`, `kilo`, `cursor`, `mastracode`, `hermes`, `omp`. Each is verified at runtime and fails
hard rather than degrading, so an untested resolver can never produce a partial transfer.

`gemini`, `agy`, `cline`, `grok`, `kiro`, `amp` and `maki` **cannot be sources**: their Herdr
integration does not report a session identity, so the owning session could only be guessed. They work
fine as targets. This matters most for `agy` — Gemini CLI was retired
on 2026-06-18 and Antigravity CLI is its successor, so an `agy` session integration is the most
valuable thing Herdr could add for this plugin.

## Platform support

Windows, macOS and Linux are all supported, and the test suite runs on all three on every push.
Being straight about what that does and does not mean:

| | status |
|---|---|
| Test suite (260 tests, all platforms) | ✅ verified in CI |
| Live handoffs on **Windows** | ✅ verified against pi, Claude Code, Codex, Hermes and Grok |
| Live handoffs on **macOS / Linux** | ⚠️ not yet exercised by the author |

CI proves the logic and the path handling, because the suite drives a stand-in for the Herdr CLI. It
cannot install Herdr or launch real agents, so a green badge is not evidence that a handoff completes
on a Mac. If you run this on macOS or Linux, reports are very welcome — an
[issue](https://github.com/sanirudh17/herdr-agent-handoff/issues) saying it just worked is as useful
as one saying it did not.

Two known differences off Windows:

- **The agent is launched differently.** macOS and Linux use Herdr's documented `agent start`. Windows
  cannot: Herdr renders the launch line with `-ArgumentList ''` for an agent that takes no arguments,
  which PowerShell rejects outright, so on Windows the agent is started by typing at the pane's own
  shell instead. The Unix path is the supported one; it is simply the one with less mileage here.
- **The prompt budget is sized for Windows.** 30,000 characters comes from Windows' 32,767-character
  command-line limit. macOS (`ARG_MAX` ≈ 256 KB) and Linux (≈ 2 MB) could inline much larger sessions,
  so on those platforms handoffs fall back to reference mode sooner than they strictly need to — which
  means the read-permission dialog appears more often than it has to. Conservative, not incorrect.

If a handoff does fail on any platform, it fails safely. The complete session is resolved *before*
anything is created, and the source pane is only ever read — never written to, closed, interrupted, or
typed into. The worst outcome is a message naming the step that failed, with the original session
untouched.

## Failure behaviour

The handoff never degrades. If the complete session cannot be obtained, it does not start:

> Full handoff unavailable: complete session context could not be retrieved for this source agent.

That also covers a session too large to inline whose native store is not readable as lines — checked
concretely: no NUL byte in the first 64 KB, valid UTF-8, at least one newline. An untested resolver
that points at a binary store fails here rather than handing over something partial.

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
npm test                                   # 260 tests, node:test, no dependencies
node bin/handoff-split.js --dry-run        # resolve + build the prompt, create nothing
herdr plugin log list --plugin agent-handoff
```

The design rationale, including the verified Herdr API findings this is built on, is in
`docs/superpowers/specs/2026-07-25-agent-handoff-design.md`. The prompt-only delivery described above
supersedes its sections 8 and 9 and is specified in
`docs/superpowers/specs/2026-07-26-prompt-only-handoff-design.md`, with the measurements behind the
size limits.
