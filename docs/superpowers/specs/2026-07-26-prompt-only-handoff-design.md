# Prompt-only handoff — design

Supersedes sections 8 and 9 of `2026-07-25-agent-handoff-design.md` (context package,
what the target receives) and revises the readiness rule in section 7. Everything else
in that document still stands.

## 1. Goal

Deliver the entire handoff inside the prompt. No `HANDOFF.md`, no snapshot directory, no
chunk files, no `SOURCE.json` — the plugin writes nothing to disk. The prompt opens with
"You are taking over this session from *<Source>*." and carries the instructions the
target needs in full.

The permission dialog some agents raise when reading a path outside the project is
accepted, not designed around. It is a one-time allow per agent, or absent under a
permissive mode.

### Non-goals

- No LLM summary, no truncation, no inferred context. Unchanged from the original design.
- No delivery of a transcript larger than an agent can hold in context. Section 3.2
  points at the file rather than pasting it for a reason beyond argv limits.

## 2. Measured constraints

Every number here was measured on this machine, not inferred.

### 2.1 The prompt has a hard ceiling of 32,767 characters

`herdr agent prompt <TARGET> <TEXT>` takes text as a positional argument. There is no
`--file` and no stdin:

```
Usage: herdr agent prompt <TARGET> <TEXT> [OPTIONS]
Options: --wait, --until <STATUS>, --timeout <MS>
```

Spawning it with arguments of increasing length:

| argument length | result |
|---|---|
| 8,000 | reached the server (`agent_not_found`) |
| 16,000 | reached the server |
| 30,000 | reached the server |
| 32,000 | reached the server |
| 40,000 | `spawnError=ENAMETOOLONG` |
| 60,000 | `ENAMETOOLONG` |
| 120,000 | `ENAMETOOLONG` |

The boundary is Windows' `CreateProcess` limit of 32,767 UTF-16 units for the whole
command line. `agent send-keys <TARGET> <KEY>...` is argv too, and takes key names rather
than text, so it is not a bypass.

### 2.2 Real sessions are far larger than that

Session stores on this machine, and how many sessions fit a 26,000-character inline
budget:

| store | sessions | fit inline | of sessions >2 KB | median | largest |
|---|---|---|---|---|---|
| claude | 290 | 154 (53%) | 9 / 145 (**6%**) | 9 KB | 140.27 MB |
| codex | 74 | 1 (1%) | 1 / 74 (**1%**) | 568 KB | 11.64 MB |
| grok | 179 | 157 (88%) | 21 / 43 (**49%**) | 1 KB | — |

Sessions under 2 KB are one-shot invocations. Among sessions representing actual work,
inlining covers a minority. **The over-budget path is the normal path** and has to be the
zero-file one as well; a fallback that reintroduces files would apply to almost every
real handoff.

A second ceiling sits above the first: a 568 KB transcript is roughly 150k tokens. Even
if argv allowed it, pasting that into a prompt would consume an entire context window
before the target began work. Reading it in ordered ranges is better on the merits, not
merely a workaround.

### 2.3 opencode has no per-session file

`~/.local/share/opencode/` contains:

```
opencode.db       318,824,448 b   (304 MiB)
opencode.db-shm        32,768 b
opencode.db-wal    21,250,992 b
account.json / auth.json / log/ / bin/ / repos/
```

There are no per-session JSON or JSONL files. Above the inline budget there is nothing to
point a target at. See section 4.

## 3. The prompt is the handoff

One prompt, built by `lib/briefing.js`, delivered by the existing `deliverPrompt` path.

### 3.1 Anatomy and budget

| part | size |
|---|---|
| command-line ceiling | 32,767 |
| reserved for `herdr agent prompt <pane>` and quoting | ~700 |
| prompt budget | 30,000 |
| briefing prose (identity, protocol, rules, boundaries) | ~3,000 |
| remaining for inline transcript | ~26,000 |

The briefing keeps the content of today's `HANDOFF.md`: the identity table (source agent
and kind, session id, source pane, workspace, tab, cwd, captured-at), the reading
protocol, "Do this, in this order", the six rules, the scope note, and the boundaries.
The rules are unchanged — read the complete source session before acting; treat it as
historical context; inspect the workspace and let it win; preserve uncommitted work;
continue from the exact stopping point; do not redo completed investigation.

If the assembled prompt would exceed 30,000 characters in mode 2, the *range list* is
what shortens (section 3.3), never the rules.

### 3.2 Mode 1 — inline, nothing on disk

The complete transcript is embedded in the prompt, verbatim, inside a fenced block, with a
line stating its byte count and SHA-256. The target reads nothing and no dialog appears.
This is the literal form of the requirement and applies to every source kind, opencode
included, because the rows are extracted in memory and never written.

Mode selection is decided on the **assembled** prompt, not on an estimate: build the mode
1 prompt, and use it when its length is ≤ 30,000 characters. Otherwise discard it and
build mode 2. This keeps fencing, escaping and prose overhead inside the measurement
rather than in a margin that could drift.

**Confirmation marker.** Delivery is proved by finding a marker on the target's screen, and
`agent read` returns only the last 400 lines. A 26,000-character prompt wraps well past
that, so an opening phrase would scroll out of the window before it could be seen. Every
prompt therefore ends with a short fixed sentinel line — `-- end of handoff, begin now --` —
and that sentinel is the primary marker. It is the last thing submitted, so it is the last
thing on screen.

**Settled by live test.** The risk was real, and worse than anticipated: `agent prompt`
delivers a large multi-line prompt as a bracketed paste and *does not submit it*. Measured
against every installed agent:

| agent | what it does with a 7,000-character prompt |
|---|---|
| pi | submits it itself, echoes it in full; sentinel visible |
| Claude Code | parks it at `❯ [Pasted text #1 +74 lines]`, **idle and unsent** 20 s later |
| Codex | parks it at `› [Pasted Content 6999 chars]`, likewise unsent |
| Grok | submits itself after ~4 s, then **truncates** its own transcript to `You 6:24 PM are taki …` |
| Hermes | submits, echoes with `... (+70 more lines)`; sentinel visible |

So delivery needs one Enter, and confirmation needs three different readings:

1. **The sentinel on screen** — primary, unchanged.
2. **One Enter, once, after a short grace period.** Spent only when nothing has happened,
   because pi submits on its own and a stray Enter there would put an empty message into a
   healthy handoff. Never spent on a target showing a question: Enter on a trust dialog
   accepts its default.
3. **The target being busy** — for agents like Grok that never put the prompt anywhere it
   can be found. This is the one place a state counts as proof and it is fenced in: it
   requires a transition the submission caused (an agent already working was working on
   something else, and a settling agent moves in and out of working by itself), it requires
   busy twice a persistence apart, and the screen must show neither a startup notice nor a
   question. The two guard tests written for the original "a state change is never delivery"
   lesson still pass unchanged.

Marker matching also had to stop depending on line width. A narrow pane wraps mid-word, one
character per line, so a capture reads `o m m i t t e d  w o r k s p a c e`; collapsing runs
of whitespace was not enough, and a delivered handoff was reported as failed while the agent
was visibly working on it. Matching now ignores whitespace entirely on both sides.

### 3.3 Mode 2 — point at the agent's own session file

Over budget → the prompt names the source agent's **native** transcript at its original
path, with:

- total line count `N`, byte count, and SHA-256 as of handoff
- an ordered list of line ranges of 1,200 lines each
- the instruction to read them in order, start to finish, before acting

The plugin writes nothing. Ordered ranges replace the old part files: they exist for the
same reason — a single 568 KB file invites a partial read — but as instructions rather
than copies.

Pinning `N` matters because the file is live. The source agent is idle after handoff but
the user may type into it. The target is told to read lines 1–`N`, so it sees exactly the
session as it stood at handoff regardless of later appends. The SHA-256 covers those
lines only.

When the range list would exceed its share of the budget, it degrades to a stated rule
rather than an enumeration: read lines 1–1,200, then each following 1,200 lines, until
line `N`. The cap is 40 enumerated ranges.

**Readability gate.** Mode 2 requires the resolved native path to be line-oriented UTF-8
text. The test is concrete: the first 64 KB contains no NUL byte, decodes as UTF-8 without
replacement characters, and contains at least one newline. If it fails — a binary store, a
database, anything the target cannot read as lines — and the session is over budget, the
handoff does not start and reports
`Full handoff unavailable: complete session context could not be retrieved for this
source agent.` This is the day-one failure rule, unchanged: never a lossy approximation.

## 4. opencode is the documented exception

opencode's only store is a 304 MiB SQLite database (section 2.3). Its rows must be
materialised somewhere before another agent can read them, so mode 2 cannot apply.

- Under the inline budget: mode 1, extracted in memory, nothing written.
- Over the inline budget: extract to **one** file inside opencode's own data directory,
  named for the source session and overwritten on each handoff of that session, so it
  never accumulates. The prompt then references it exactly as mode 2 does, with line
  count, SHA-256 and ranges.

This is the single place the plugin writes a file, and it is stated in the README as such.
The alternative — refusing any opencode session over 26 KB — would remove working
functionality, and 26 KB is below the median session in every store measured.

*Not verifiable on this machine.* opencode 1.18.5 crashes on startup here, dumping a Bun
crash report (`bun.report/1.3.14/…`) and returning the shell prompt, so it cannot receive a
handoff at all and the permission question could not be answered. The export path itself is
covered by unit tests against a real SQLite store. Whether opencode prompts for a read
inside its own data directory remains open; if it does, the exception costs a click, which
is acceptable per section 1, and nothing else changes.

That crash also exposed a reporting gap. A vanished target was always read as the user
closing the pane — correct for that case, and deliberately silent, because the handoff had
worked and saying otherwise would be a lie. But opencode leaves its *pane* behind with no
agent in it, and reporting that as a deliberate close made a crashed launch look like a
handoff that had silently done nothing. A pane that survives without its agent is now
reported: `Handoff failed: opencode exited before accepting the handoff. Source pane
untouched.`

## 5. Readiness: making the prompt-line rule real

The rule received in `c6d1434` is correct in intent — a startup banner sitting above an
agent's input line is scrollback, not current state — and inert in fact.

### 5.1 Why it cannot fire

`readScreen` returns `normalize(out)`, and `normalize` is
`replace(/\s+/g, " ")`. Every marker in `PROMPT_MARKERS` begins with a newline. Measured
on live panes:

| pane | raw chars | newlines in raw | newlines after normalize |
|---|---|---|---|
| pi (`w7:p1`) | 1,412 | 52 | 0 |
| agy (`w7:p4`) | 1,002 | 37 | 0 |

So the marker lookup never matches, `textAfterLastPrompt` returns `null`, and `startingUp`
falls through to the pre-existing tail match. The `startsWith(">")` escape does not fire
either: agy's capture begins `PS C:\Users\sanir\Herdr Plugin> agy ▄▀▀▄`. `startingUp`
returns `false` for agy's current screen with or without the change.

Its unit test passes because it hands `startingUp` a hand-built multi-line string. The
real screen has no newlines by the time the function sees it — the same class of gap as
the stdout/stderr and JSON/plain-text bugs earlier on this branch.

### 5.2 Nor would the marker list generalise

Input lines captured from live panes:

| agent | input line as rendered |
|---|---|
| claude | `───────────────────────────❯                    ───────────────────────────` |
| grok | `│ >                   │` inside `╭───╮` / `╰─ Grok 4.5 (medium) ─╯`; whole capture is **1 line, no newlines** |
| agy | `>` |
| codex | trust dialog: `› 1. Yes, continue` |
| hermes | 68 chars over 4 lines at 18 s; no input line yet |

claude's `❯` and grok's `>` sit *inside* border lines, so they are not at line start and a
`\n❯` test misses them even on raw text. The list matches one agent of five.

### 5.3 The replacement

- `readScreen` returns the **raw** capture. Call sites that need `includes` normalise
  locally; a single `flat()` helper wraps `normalize`.
- Input-line detection is line-shaped and border-tolerant: split raw into lines, walk the
  last 8 non-blank lines bottom-up, strip box-drawing characters
  (`─│╭╮╰╯┌┐└┘├┤┬┴┼━┃▌▐█▀▄` and friends) and whitespace from both ends, and treat the line
  as the input line if what remains begins with `>` `❯` `›` `▶` `»` `⏵` `$` `%` `#`.
- `NOT_READY` is matched only against the text from that line to the end of the capture,
  normalised. Phrases above it are history; a notice in a footer *below* it still counts.
- No input line found — including grok's newline-free capture — falls back to today's
  400-character tail. Unknown agents therefore degrade to current behaviour rather than
  breaking, which is the requirement for the fourteen kinds not installed here.
- `needsAnswer` keeps matching the whole tail. A question anywhere near the bottom is a
  reason not to type, and codex's trust dialog is exactly that.

### 5.4 Why this is safe for the agents that work today

agy: `false` before and after, verified against its live screen. claude and grok gain
protection they did not have. pi, hermes and codex are unaffected where no input line is
detected. No agent moves from "ready" to "starting up", so nothing that delivers today
stops delivering.

## 6. Module changes

| module | change |
|---|---|
| `lib/briefing.js` | `render()` returns the full prompt string for both modes; `kickoff()` and `partsTable()` are removed. |
| `lib/snapshot.js` | Stops copying. Measures the native file: line count, byte count, SHA-256, and the range list. `write()`, `prune()`, `makeReadOnly()`, `SOURCE.json` and the chunk writer go. `chunk()` survives only as the range calculator. |
| `lib/source-sqlite.js` | Gains an in-memory extraction returning a buffer; the file export stays for the section 4 exception. |
| `lib/handoff.js` | `readScreen` returns raw; `flat()` at the `includes` sites; the section 5.3 input-line detector; mode selection and prompt assembly; the readability gate. |
| `lib/paths.js` | The handoffs base directory is no longer created. |
| `README.md` | Records that nothing is written except the opencode exception. |

The pending storage question — prune to 3, reuse a directory per session — is resolved by
deletion. There is nothing left to prune.

## 7. Errors

| condition | message |
|---|---|
| over budget and native path is not line-oriented text | `Full handoff unavailable: complete session context could not be retrieved for this source agent.` |
| over budget, opencode, export fails | same |
| assembled prompt exceeds the ceiling after range degradation | same |

No new user-facing vocabulary. The existing catalogue in section 10 of the original spec
is otherwise unchanged.

## 8. Testing

- Prompt assembly at the boundary: a session one byte under the inline budget inlines; one
  byte over switches to mode 2. Both prompts are asserted under 32,767 characters.
- Byte-exactness of mode 1: the inlined transcript equals the source file byte for byte.
- Range arithmetic covers every line exactly once, with no gap and no overlap, and the
  last range ends at `N`.
- Range degradation past 40 ranges produces the stated rule and a prompt under budget.
- Readability gate: a binary native path over budget fails with the catalogue message.
- Readiness fixtures are the **captured screens in section 5.2**, stored as files holding
  the real bytes, and reach `startingUp` only through `readScreen` driven by the fake CLI —
  never as hand-built literals. Specifically: agy's banner-above-prompt screen is not
  starting up; claude's `───❯───` line is detected as an input line; grok's single-line
  capture falls back to the tail; codex's trust dialog is `needsAnswer`.
- A guard test asserting each fixture round-trips through `readScreen` with its newlines
  intact. Since 5.3 makes `readScreen` return raw text, a fixture that lost its newlines
  would silently re-create the inert behaviour of `c6d1434`, and this is what catches that.

## 8a. Live results

Verified end to end through `handoff.run()`, prompt-only, nothing written:

| target | mode | delivered | how it was confirmed |
|---|---|---|---|
| pi | inline, 6,992 ch | 11.9 s | sentinel echoed in full; began reading the plan doc |
| Claude Code | inline, 7,005 ch | 11.7 s | one Enter, then sentinel; started running commands |
| Codex | inline, 6,998 ch | 13.1 s | one Enter, then sentinel; acknowledged in one line and worked |
| Codex | **reference**, 3,968 ch from a 16.29 MB / 4,726-line session | 13.2 s | one Enter, then sentinel; read the named file |
| Hermes | inline, 7,006 ch | 37.5 s | sentinel visible past its `(+70 more lines)` elision |
| Grok | inline, 6,996 ch | 41.2 s | busy fallback; context counter climbing, no echo to find |
| Antigravity | inline | not delivered | its own account verification; reported as not-yet-ready |
| opencode | inline | not delivered | crashes on startup here; reported as exited |

Reference mode is the headline number: a 16.29 MB session became a 3,968-character prompt.

Two agents did not deliver, and neither for a reason inside the plugin. Antigravity's screen
says `We're finishing verifying your account eligibility. Please try again shortly.` while it
discards input, and opencode 1.18.5 crashes before it can receive anything. Both are now
reported accurately rather than as generic failures, and the source pane is untouched in both
cases.

One flake seen: pi's first launch in a fresh pane failed to accept the prompt once, then
succeeded on every subsequent run. Its screen showed neither a startup notice nor a question,
so the retry loop had nothing to act on. Not reproduced since; recorded rather than guessed at.

## 9. Limitations

- Mode 2 leaves a permission dialog on agents that gate reads outside the project.
  Accepted per section 1.
- Mode 2 depends on the source agent's native layout, which is verified for claude, codex,
  pi and grok and best-effort for the rest. An unverified layout that resolves to
  unreadable bytes fails cleanly via the readability gate rather than transferring
  something partial.
- The opencode exception writes one file. There is no way to avoid it for a 304 MiB
  database with no per-session files.
- grok's capture arrives without newlines, so it gets no benefit from the input-line rule
  and keeps the character tail.
