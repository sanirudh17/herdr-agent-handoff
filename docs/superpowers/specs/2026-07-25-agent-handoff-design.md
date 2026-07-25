# Agent Handoff — Herdr plugin design

**Date:** 2026-07-25
**Status:** approved for planning
**Target Herdr:** 0.7.5 (verified against `0.7.5-preview.2026-07-21-0f10e1453a7f`, protocol 17)

## 1. Goal

Transfer an in-progress task from the agent in the active pane to a **fresh session of another
installed Herdr-supported agent**, with no manual copying, summarizing, or follow-up prompt writing.

This is a full-session **ownership transfer**. It is not a task dispatcher, not a generic agent
launcher, and not a supervisor/orchestrator. The source pane is never modified.

### Non-goals

- Editing, approving, or previewing the transferred context.
- Summarizing, compressing, or filtering session history.
- Monitoring the target, collecting its result, or coordinating the two agents.
- Closing, interrupting, or writing to the source pane.
- Transferring anything other than the single active session.

## 2. Verified Herdr capabilities

Every capability below was confirmed against the installed binary, the live socket API, the running
server, and the upstream source. Nothing in this design rests on an assumed API.

### 2.1 Herdr stores no transcripts

`pane.read` exposes exactly four sources: `visible`, `recent`, `recent-unwrapped`, `detection`.
All four are terminal screen/scrollback projections. The spec forbids these as a transfer
mechanism or fallback, and this design never calls `pane.read`.

### 2.2 Herdr exposes a native session *reference*

`PaneInfo` / `AgentInfo` carry:

```json
"agent_session": { "agent": "pi", "kind": "id", "source": "herdr:pi",
                   "value": "019f951b-deda-7ad6-8303-d6f22deccf3e" }
```

`AgentSessionRefKind` is `id | path`.

Integrations report via `pane.report_agent_session`, whose params include **both**
`agent_session_id` and `agent_session_path`. However, `src/agent_resume.rs`:

```rust
pub fn session_ref_from_report(...) -> Option<AgentSessionRef> {
    if !is_official_agent_source(source, agent) { return None; }
    if agent == "pi" || agent == "omp" {
        return _agent_session_path.and_then(AgentSessionRef::path)
            .or_else(|| agent_session_id.and_then(AgentSessionRef::id));
    }
    agent_session_id.and_then(AgentSessionRef::id)
}
```

**Herdr retains `agent_session_path` only for `pi` and `omp`.** For every other agent the path is
discarded and only the id is kept — even though, for example, `~/.claude/hooks/herdr-agent-state.ps1`
does report Claude Code's full `transcript_path`.

**Consequence:** obtaining complete context requires the plugin to resolve
*(agent kind, session id)* → the agent's own native session file on disk. This is the central
mechanism of the feature.

### 2.3 Which agents can be a source

`is_official_agent_source()` restricts session reporting to 15 agent/source pairs:

`claude, codex, copilot, devin, droid, kimi, omp, mastracode, pi, hermes, opencode, qodercli,
kilo, cursor, grok`

The other six kinds Herdr can start — `gemini, agy, cline, kiro, amp, maki` — never report a
session reference, so they **cannot be handoff sources**. They are still valid targets.

### 2.4 Which agents can be a target

`agent.start --kind` accepts 21 kinds: `pi, claude, codex, gemini, cursor, devin, agy, cline, omp,
mastracode, opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, maki`.

### 2.5 Plugin UI

- Plugin v1 has **no native non-terminal UI**. Actions, event hooks, panes and link handlers are
  all declared in `herdr-plugin.toml`.
- `PluginPanePlacement` = `overlay | popup | split | tab | zoomed`. `popup` is session-modal and
  omits `HERDR_PANE_ID`.
- `herdr plugin pane open --placement` accepts only `overlay, split, tab, zoomed` — **not `popup`**.
  `src/app/api/plugins/mod.rs:385` resolves `params.placement.unwrap_or(pane.placement)`, so
  declaring `placement = "popup"` in the manifest and omitting the CLI flag yields a popup.
- `mod.rs:395` rejects a popup unless `state.mode == Mode::Terminal`.
- `panes.rs:39` calls `terminal.set_manual_label(pane.title)`, so the manifest `title` becomes the
  popup's visible label — this is how the modal gets titled "Handoff to Agent".
- `plugin.pane.open` accepts `env`, so the source pane id can be handed to the popup deterministically
  rather than re-derived. Nine keys are protected and cannot be overridden
  (`plugin_pane_protected_env_key`); none collide with the names used here.

### 2.6 Keybindings

`CommandKeybindConfig` in the binary enumerates exactly four command types:
`shell`, `pane`, `popup`, `plugin_action`.

`RawPluginManifest` (`src/app/api/plugins/manifest.rs`) has fields `id, name, version,
min_herdr_version, description, platforms, build, startup, actions, events, panes, link_handlers`
— **no keybinding section**. Keybindings therefore must live in the user's `config.toml` as
`[[keys.command]]` with `type = "plugin_action"`.

`prefix+h` is Herdr's default `focus_pane_left`, so the requested `prefix h` is unavailable.
`prefix+a` / `prefix+shift+a` are both unbound in the default config.

### 2.7 Plugin action execution

`src/app/api/plugins/runtime.rs` spawns each action on a background thread with
`.current_dir(plugin_root)`, piped stdout/stderr captured to a 64 KB cap, and **no timeout**.
Limit is 32 concurrent plugin commands. An action may therefore orchestrate a multi-second handoff
and outlive the popup it opened.

### 2.8 Other verified calls

| Need | Call |
|---|---|
| Source pane facts | `herdr pane get <id>` |
| Split beside source | `herdr pane split --pane <id> --direction right --no-focus --cwd <path>` |
| New tab in workspace | `herdr tab create --workspace <id> --no-focus --cwd <path>` |
| List panes | `herdr pane list` |
| Start agent | `herdr agent start <name> --kind <k> --pane <p> --timeout <ms>` |
| Deliver prompt | `herdr agent prompt <name> <text>` |
| Focus target | `herdr agent focus <name>` |
| Feedback | `herdr notification show <title> --body <text>` |
| Config path | `herdr --help` → `Config: <path>` |

`herdr pane focus` only focuses a *neighbouring* pane, so `agent focus` is the correct call for
activating the target.

Response shapes matter for step 8 of §7: `pane.split` returns `pane_info`, carrying the new
`pane_id` directly. `tab.create` returns `tab_info`, which has `tab_id` and `pane_count` but **no
pane ids** — so the new tab's pane must be resolved with `pane list`, filtering on that `tab_id`.
A freshly created tab has exactly one pane, making this deterministic.

### 2.9 Windows socket note

The API socket on Windows is a named pipe reachable as `\\.\pipe\<socket path>`; the `.sock` file
itself is not connectable (`ENOTSOCK`). This design avoids the issue entirely by using the Herdr
CLI via `HERDR_BIN_PATH` for all Herdr access.

## 3. Source coverage

Five layouts verified on disk. Four are flat files; one is a database.

| agent | root | match | strategy |
|---|---|---|---|
| `claude` | `$CLAUDE_CONFIG_DIR`/`~/.claude` → `projects/*/` | file named `<id>.jsonl` | `file` |
| `codex` | `$CODEX_HOME`/`~/.codex` → `sessions/**/` | file `rollout-*-<id>.jsonl` | `file` |
| `pi` | `~/.pi/agent/sessions/**/` | file `*_<id>.jsonl` | `file` |
| `grok` | `~/.grok/sessions/*/` | **directory** named `<id>`, file `chat_history.jsonl` | `file` |
| `opencode` | `~/.local/share/opencode/opencode.db` | rows keyed on `session_id = <id>` | `sqlite` |

Plus `pi` and `omp` when Herdr reports `kind: "path"` — used directly, no resolution needed.

**Best-effort resolvers** (documented roots, runtime-verified, hard-fail if unresolved):
`copilot` (`~/.copilot`), `devin` (`~/.devin`), `droid` (`~/.factory`), `kimi` (`~/.kimi-code`),
`qodercli` (`~/.qoder`), `kilo` (`~/.config/kilo`), `cursor` (`~/.cursor`),
`mastracode` (`~/.mastracode`, `~/.mastra`), `hermes` (`~/.hermes/sessions`),
`omp` (`~/.omp/agent/sessions`).

That accounts for all 15 agents that can be sources: 5 verified, 10 best-effort.

### 3.1 File strategy

1. If `agent_session.kind == "path"`: use the value directly.
2. Else, for each configured root (first existing wins), walk at most depth 6 and 20 000 entries:
   - collect files whose basename matches the agent's pattern and contains the session id;
   - collect directories whose basename equals the session id, then their candidate files.
3. Verified agents use their exact pattern. Best-effort agents accept extensions
   `.jsonl .json .md .log` and require the id to appear in the path.
4. **Accept only an unambiguous result.** Exactly one candidate file. A matching directory must
   contain exactly one candidate file. Zero matches, or more than one, is a hard failure.
5. Validate: file exists, size > 0, at least one line.

Traversal never leaves the agent's own home root. Format is never interpreted — the plugin copies
bytes and counts newlines, which is what keeps this strategy lossless and format-agnostic.

### 3.2 SQLite strategy (opencode)

opencode migrated its session store into SQLite; `storage/` now holds only `session_diff` and
`migration`. The database is nonetheless a **complete and losslessly extractable** transcript, keyed
by exactly the session id the opencode integration reports. Verified schema and live row counts:

| table | rows here | keyed by | relevance |
|---|---|---|---|
| `session` | 707 | `id` | `directory, title, agent, model, time_created` |
| `message` | 13 910 | `session_id` | `id, time_created, data` (JSON) |
| `part` | 54 241 | `session_id` | `id, message_id, data` (JSON) — text, tool calls, results |
| `session_message` | 11 | `session_id` | newer message table, same shape plus `seq` |
| `todo` | 735 | `session_id` | `content, status, priority, position` — **current task state** |
| `event` | 23 612 | `aggregate_id` | append-only log: `message.part.updated`, `message.updated`, … |

`message`/`part` are the materialized projection; `event` is the append-only log behind it. Verified
on the newest session (`ses_06af8a6fcffeIyWB7w5lX0xE7y`): 12 messages, 40 parts, 135 events.

`event` is exported **when present but never required** — `event_sequence` holds only 39 aggregates
against 707 sessions, so opencode prunes the log for older sessions. Including it when it exists
means the export carries both the log and the projection; requiring it would fail handoffs from
perfectly intact older sessions. The required backbone is `session` + `message` + `part`.

Note also that opencode session ids are `ses_`-prefixed, not UUIDs. No resolver in this design assumes
a UUID shape — the file strategy matches on "basename contains the id" — but it is worth stating so
no future change bakes in a UUID pattern.

Extraction:

1. Copy `opencode.db`, `-wal` and `-shm` together into the snapshot working directory. opencode runs
   in WAL mode, so a read-only open of the live file can fail while opencode holds it; copying all
   three lets SQLite recover a consistent view from the copied WAL.
2. Open the **copy** read-only via `node:sqlite` (`new DatabaseSync(path, { readOnly: true })`).
   The user's live database is never opened, never locked, and never written.
3. Emit one JSONL line per row, in deterministic order, with every `data` column preserved verbatim:
   the `session` row, then `message` ordered by `(time_created, id)`, then `part` ordered by
   `(message_id, time_created, id)`, then `session_message` ordered by `(seq, id)`, then `todo`
   ordered by `position`, then `event` ordered by `seq` if any exist. Each line is
   `{"table": "<name>", "row": {...}}`.
4. Re-query every table's count for the session after the export and assert it equals the number of
   lines emitted for that table. A mismatch is a hard failure.
5. Require a non-empty `session` row and at least one `message`; otherwise hard-fail.

This is a mechanical transcode, not a summary: every row belonging to the session is emitted and no
`data` payload is altered. `todo` is included because "current task state" is explicitly part of the
required context.

`node:sqlite` requires Node ≥ 22.5. It is feature-detected; if unavailable, opencode hard-fails with
a message naming the reason rather than degrading.

## 4. Architecture

Node.js ≥ 18, **zero runtime dependencies** (so `[[build]]` is empty and `herdr plugin link` works
immediately). Node is the runtime Herdr's own integrations use. All Herdr access is through the CLI
at `HERDR_BIN_PATH`, giving one code path on Windows, macOS and Linux.

```
agent-handoff/
  herdr-plugin.toml        id = "agent-handoff"; platforms = ["linux","macos","windows"]
  package.json             name/type only, no dependencies
  bin/handoff-split.js     action: destination = split
  bin/handoff-tab.js       action: destination = new tab
  bin/picker.js            popup pane: the modal
  bin/setup-keys.js        action: patch config.toml
  lib/herdr.js             CLI wrapper — spawn, JSON parse, typed errors
  lib/agents.js            registry of 21 kinds: friendly name, id, executable candidates
  lib/sources.js           session-store resolvers + validation (file strategy)
  lib/source-sqlite.js     opencode SQLite extraction (sqlite strategy)
  lib/snapshot.js          chunked copy/export + SOURCE.json
  lib/briefing.js          HANDOFF.md generator
  lib/handoff.js           orchestrator
  lib/ipc.js               action ↔ picker request/result protocol
  lib/ui.js                raw-key + SGR-mouse TUI primitives
  test/                    node:test unit tests + fixtures
  README.md
```

Two actions rather than one parameterised action, so each binds to its own key and
`herdr plugin action list` reads clearly.

### 4.1 Module contracts

- **`herdr.js`** — `run(args) → parsed JSON | text`, throwing `HerdrCliError {code, message}`.
  Sole owner of subprocess handling and `HERDR_BIN_PATH` resolution. Nothing else spawns Herdr.
- **`agents.js`** — `all()`, `byKind(k)`, `available()`. Owns friendly names and executable
  candidates; resolves executables against `PATH` honouring `PATHEXT` on Windows. No Herdr knowledge.
- **`sources.js`** — `resolve({agent, sessionRef}) → {strategy, path, lines, bytes, sha256}` or
  throws `SourceContextUnavailable`. Pure filesystem; no Herdr, no UI. Dispatches to
  `source-sqlite.js` when the agent's strategy is `sqlite`.
- **`source-sqlite.js`** — `extract({dbPath, sessionId, outDir}) → {lines, bytes, counts}`. Owns the
  copy-then-read-only-open dance and the row-count assertions. Feature-detects `node:sqlite`.
  The only module aware that SQLite exists.
- **`snapshot.js`** — `write({sourceInfo, destination, dir}) → {dir, parts, totals}`. Chunking is
  identical for both strategies; for `file` the parts reassemble byte-for-byte.
- **`briefing.js`** — pure function: snapshot metadata → HANDOFF.md text. No I/O.
- **`ipc.js`** — request/result files with atomic writes; `waitForResult(id, timeoutMs)`.
- **`ui.js`** — terminal setup/teardown, key decoding, mouse decoding, row rendering. No handoff logic.
- **`handoff.js`** — the only module that composes the others.

Each module is independently testable, and the two with real risk (`sources.js`, `snapshot.js`) have
no Herdr or UI dependency at all.

## 5. Keybindings

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

`bin/setup-keys.js`, invoked explicitly via
`herdr plugin action invoke agent-handoff.setup-keys`:

1. Locate `config.toml`: `$HERDR_CONFIG_PATH`, else the `Config:` line of `herdr --help`, else
   `~/.config/herdr/config.toml`. Create it if absent.
2. Back up to `config.toml.bak-<utc-ts>`.
3. Idempotent: if a `[[keys.command]]` already targets `agent-handoff.handoff-split` or
   `-tab`, rewrite that block rather than appending a duplicate.
4. If `prefix+a` or `prefix+shift+a` is already bound to something else, **refuse** and report the
   conflict; `--force` overrides.
5. `herdr server reload-config`.

The plugin never writes to `config.toml` unless this action is invoked.

## 6. Modal UX

Declared as a manifest pane so the popup is titled by Herdr:

```toml
[[panes]]
id = "picker"
title = "Handoff to Agent"
placement = "popup"
width = "70%"
height = "70%"
command = ["node", "bin/picker.js"]
```

Layout:

```
Handoff to Agent                                        7 / 21 available

pi · w5:p1 · 4,812 lines  →  new tab in workspace 5

  ▸ Claude Code                     claude
    Codex                           codex
    pi                              pi          same agent, fresh session
    Grok                            grok
    opencode                        opencode
    Hermes Agent                    hermes
    Antigravity                     agy

  14 more supported agents not installed · ? to show

  ↑↓ move · 1-9 jump · enter select · esc cancel
```

(The counts above are this machine's actual roster: `pi, claude, codex, agy, opencode, grok, hermes`
resolve on `PATH`; the other 14 kinds do not.)

Deliberately minimal: one context line (source agent, source pane, session size → destination) and
the roster. Nothing else earns a row, because the whole interaction is meant to be
shortcut → choose → gone.

- Only available agents are navigable. The source agent is selectable and labelled
  *same agent, fresh session*.
- `?` toggles a dimmed, non-navigable block listing the not-installed kinds. The cursor never
  enters it. Default view therefore lists only installed agents, and nothing unselectable can be
  selected.
- Keys: `↑`/`↓`/`k`/`j` move, `1`–`9` jump, `Enter` select, `Esc`/`q`/`Ctrl+C` cancel.
  Lists longer than the viewport scroll.
- Mouse: SGR 1006 enabled; a click on a row selects it immediately. Herdr forwards mouse events to
  pane apps that request them.
- Selecting writes the result and exits, closing the popup at once. Progress is not shown in the
  modal — the user watches the real pane boot, then gets a confirmation toast.

## 7. Orchestration

The **action process orchestrates; the popup only picks.** The popup is session-modal, so focusing
the target must happen after it closes, and per §2.7 the action process outlives it.

1. Parse `HERDR_PLUGIN_CONTEXT_JSON` → `focused_pane_id`, `workspace_id`, `tab_id`.
2. `herdr pane get <focused_pane_id>` → `agent`, `agent_session`, `cwd`.
   No agent → error, stop.
3. **Resolve and validate the source transcript before the modal opens.** On failure: error toast,
   exit — no modal, nothing created. (Requirement: never start a handoff that cannot complete.)
4. Build the roster from `agents.available()`.
5. Write the request file; `herdr plugin pane open --plugin agent-handoff --entrypoint picker
   --env HERDR_HANDOFF_REQUEST=<file> --focus`. If Herdr rejects the popup because the UI is not in
   terminal mode (§2.5), retry with `--placement overlay`. This is a UI fallback only — it never
   affects what context is transferred.
6. Wait for the result file (poll 60 ms, timeout 300 s). Cancelled or timed out → exit silently,
   clean up.
7. Re-validate the source, then write the snapshot.
8. Create the target:
   - split → `pane split --pane <src> --direction right --no-focus --cwd <src cwd>`; the
     `pane_info` response carries the new `pane_id`.
   - new tab → `tab create --workspace <ws> --no-focus --cwd <src cwd>`; the `tab_info` response has
     no pane ids, so resolve the tab's single pane via `pane list` filtered on the new `tab_id`.
9. `agent start handoff-<kind>-<n> --kind <kind> --pane <pane> --timeout 60000`.
10. `agent prompt <name> "<kickoff>"`.
11. `agent focus <name>`.
12. `notification show "Handoff started: pi → Claude Code (new tab)"`.

The source pane is touched by exactly one read-only call, `pane get`. Nothing sends it input,
closes it, or moves its focus.

## 8. Context package

`$HERDR_PLUGIN_STATE_DIR/handoffs/<utc-ts>-<src>-to-<dst>/`

```
session/part-001.jsonl   chunks, 1200 lines or 256 KB per part
session/part-002.jsonl
SOURCE.json
HANDOFF.md
```

- **`file` strategy — chunks are verbatim.** Concatenating them reproduces the original
  byte-for-byte; this is an enforced test, not an intention. Nothing is filtered, reordered, or
  rewritten.
- **`sqlite` strategy — chunks are the full deterministic row export** of §3.2, with every `data`
  payload preserved verbatim. The completeness guarantee here is the post-export row-count assertion
  rather than byte equality, since there is no single original file to compare against.
- **`SOURCE.json`** — source agent kind and friendly name, session id, native path, resolution
  strategy, sha256, byte size, total line count, every part with its line range, per-table row
  counts for the `sqlite` strategy, source pane / workspace / tab ids, cwd, snapshot timestamp.
- Marked read-only: mode `0444` on POSIX, ReadOnly attribute on Windows.
- Retention: the 20 most recent handoff directories are kept; older ones are pruned.

Chunking exists to defend the *target* side of the completeness guarantee. Real sessions are large
— the live pi session measured 862 KB, a codex rollout 521 KB — and a single file that big invites an
agent to read only part of it. `HANDOFF.md` states the part count and total line count and requires
reading every part in order, which makes "no silent omission" checkable rather than hoped for.

Snapshots are taken at a moment in time, so the source may advance by a turn afterwards. That is
covered by directive 3: the workspace is authoritative.

## 9. What the target receives

Kickoff prompt — deliberately a single line with no newlines, because `agent prompt` appends Enter
and a multi-line paste can submit early in some agents:

```
Session handoff from pi. You now own this task. Read <abs>/HANDOFF.md in full before doing anything else, then follow it exactly.
```

`HANDOFF.md` contains the metadata, the reading protocol (part count, total lines, read all parts in
order, do not skip, do not summarize), and the six required directives:

1. **Read the complete source session before acting** — every part, in order.
2. **Treat it as historical context** — a record of what happened, not instructions to re-execute.
3. **Inspect the current workspace; it is authoritative** wherever it differs from history.
4. **Preserve uncommitted work** — never revert, stash, discard, or clean.
5. **Continue from the exact stopping point.**
6. **Do not redo completed investigation** unless the workspace contradicts it.

Plus: the handoff directory is read-only; the source pane and its session are off-limits.

Both coding and general information/conversation work are supported. For non-coding sessions the
briefing frames "workspace" as the files, notes, and artifacts the session referenced, so directive 3
still applies.

## 10. Errors

Every failure surfaces as a `notification show` toast, and none of them touch the source.

| Condition | Message |
|---|---|
| Active pane has no agent | `Handoff unavailable: the active pane is not a running agent.` |
| Kind cannot be a source (§2.3), no session ref, or unresolved / ambiguous / empty transcript | `Full handoff unavailable: complete session context could not be retrieved for this source agent.` |
| opencode source but `node:sqlite` unavailable (Node < 22.5) | `Full handoff unavailable: reading opencode's session store requires Node 22.5 or newer.` |
| opencode row-count assertion failed | `Full handoff unavailable: complete session context could not be retrieved for this source agent.` |
| Target pane/tab creation failed | `Handoff failed: could not create the target <split\|tab>. Source pane untouched.` |
| `agent start` failed or timed out | `Handoff failed: <Agent> did not start. Source pane untouched.` |
| `agent prompt` failed | `Handoff failed: <Agent> started but did not accept the handoff. Source pane untouched.` |

There is no truncated-transcript, scrollback, git-diff, or inferred-summary path anywhere in the
code. `pane read` is never called, so such a fallback cannot be introduced by accident later.

On a step 8–11 failure the created pane is left in place for inspection rather than silently closed,
and the toast says so.

## 11. Testing

Built-in `node:test`; no test dependencies.

**Unit**

- `agents.js`: executable resolution against a fake `PATH` for each platform, including `PATHEXT`
  and the alias cases (`cursor`→`cursor-agent`, `qodercli`→`qoder`, `agy`→`antigravity`).
- `sources.js`: fixture trees reproducing all four verified file layouts; `kind:"path"` passthrough;
  zero-match, multi-match and empty-file hard failures; traversal bounds; refusal for
  non-integrated kinds.
- `source-sqlite.js`: a fixture database built to the §3.2 schema — export ordering is
  deterministic, every row for the session is emitted, rows from *other* sessions are excluded,
  `data` payloads survive byte-identical, the row-count assertion fails loudly on a truncated
  export, and a missing `node:sqlite` produces the specific error rather than a generic one.
  The live user database is never touched by tests.
- `snapshot.js`: byte-exact reassembly for the `file` strategy; empty file, single line, no trailing
  newline, exact chunk-boundary sizes; part line ranges sum to the total.
- `briefing.js`: all six directives present; part count and totals match the snapshot.
- `setup-keys.js`: creates a missing config; idempotent re-run; refuses a foreign binding on
  `prefix+a`; makes a backup.
- `ipc.js`, `ui.js`: result protocol; key and SGR-mouse decoding.

**Integration**

- `--dry-run` orchestrator mode: resolves, snapshots and prints the plan without creating panes.

**Live smoke test**

- Hand this pi session off to Claude Code on the running Herdr, in both split and new-tab modes,
  confirming the source pane is unchanged and the target reads the full transcript.

## 12. Known limitations

- Six kinds — `gemini, agy, cline, kiro, amp, maki` — cannot be sources, and the reason is a Herdr
  gap rather than a storage one. `is_official_agent_source()` excludes them, so Herdr reports no
  `agent_session` at all for such a pane. Without a session identity the plugin cannot know *which*
  session the pane owns; the only alternative would be inferring it (say, the newest session for that
  cwd), and guessing wrong would transfer someone else's conversation. Inference is exactly what this
  feature forbids, so these remain targets only. See §13.3.
- **`agy` (Antigravity CLI) is the one that matters.** Gemini CLI was retired on 2026-06-18 and
  Antigravity CLI is its successor, so `agy` is the Google-side agent people will actually be running
  — and it is currently the highest-value missing source integration. Nothing was found on disk here
  to resolve against either: `~/.antigravity-ide` holds only `extensions/` and `argv.json`,
  `%LOCALAPPDATA%\agy` only `bin/`, and `%APPDATA%\Antigravity` is an Electron profile for the
  desktop app. Even a discovered store would not fix the identity problem above.
- `gemini` stays in the target registry because Herdr still accepts the kind, but it is deprecated
  upstream; anyone still holding the binary will see it listed.
- `maki` is target-only for the same identity reason. Low enough usage that no upstream request is
  proposed unless someone asks.
- Ten best-effort resolvers are unverified; each hard-fails rather than degrading.
- opencode as a source additionally requires Node ≥ 22.5 for `node:sqlite`.
- Keybindings live in the user's `config.toml`; the plugin manifest cannot declare them.
- The transferred session is the current native session identified by Herdr. History discarded by
  the source agent itself (e.g. after `/clear`) is not recoverable.
- Requires Node ≥ 18 on `PATH`.

## 13. Upstream issues found

1. `src/agent_resume.rs` `session_ref_from_report()` discards `agent_session_path` for all agents
   except `pi` and `omp`, even when the integration reports it. Claude Code's hook sends
   `transcript_path` and Herdr drops it. Retaining it would make full-context handoff possible for
   every integrated agent without per-agent resolvers.
2. The pi integration guards with `file.startsWith("/")` before reporting a path, so on Windows it
   always falls back to the session id. The file is Herdr-managed, so it is not patched here.
3. **Antigravity CLI (`agy`) has no session integration.** Gemini CLI was retired on 2026-06-18 and
   Google now directs developers to Antigravity CLI, so `agy` is likely to become one of the more
   widely used kinds Herdr supports — yet it is absent from `is_official_agent_source()` and reports
   no session identity. Adding an `agy` integration (or, better, fixing issue 1 so any integration's
   reported path is retained) would make it a first-class handoff source. Worth filing alongside 1.

References for the Gemini CLI retirement:
[Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/),
[The Register, 2026-05-20](https://www.theregister.com/ai-ml/2026/05/20/bye-bye-gemini-cli-google-nudges-devs-toward-antigravity/5243605).
