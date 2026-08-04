"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderInline, SENTINEL, PROMPT_BUDGET } = require("../lib/briefing.js");

const nodePath = require("node:path");
// Built with path.join so basename() works on every platform, not just Windows.
const NATIVE_PATH = nodePath.join("C:", "x", "rollout-1.jsonl");
const BIG_NATIVE_PATH = nodePath.join(
  "C:",
  "Users",
  "sanir",
  ".codex",
  "sessions",
  "rollout-2026-03-31-019d4393.jsonl",
);

const META = {
  sourceKind: "codex",
  sourceName: "Codex",
  targetKind: "claude",
  targetName: "Claude Code",
  sessionId: "019d4393-fd0e-77f2-88a2-782589d290a5",
  sourcePaneId: "w6:p1",
  workspaceId: "w6",
  tabId: "w6:t1",
  cwd: "C:\\Users\\sanir\\Herdr plugin",
  destination: "tab",
  strategy: "file",
  snapshotUtc: "2026-07-26T09:30:00.000Z",
};

function sessionOf(text) {
  const body = Buffer.from(text, "utf8");
  return {
    strategy: "file",
    nativePath: NATIVE_PATH,
    body,
    bytes: body.length,
    lines: text.split("\n").length - 1,
    sha256: "a".repeat(64),
    counts: null,
    readable: true,
  };
}

const inlineOf = (text) =>
  renderInline({ meta: META, session: sessionOf(text) });

test("the prompt opens by telling the target it is taking over, and names the source", () => {
  assert.match(
    inlineOf('{"n":1}\n'),
    /^You are taking over this session from \*\*Codex\*\*/,
    "this exact opening was the requirement",
  );
});

test("the transcript is embedded verbatim, byte for byte", () => {
  const transcript =
    '{"role":"user","text":"hello ─ ❯ world"}\n{"role":"assistant"}\n';
  assert.ok(
    inlineOf(transcript).includes(transcript),
    "no escaping, no reflowing, no truncation",
  );
});

test("the prompt states what to verify the transcript against", () => {
  const s = sessionOf('{"n":1}\n');
  const text = renderInline({ meta: META, session: s });
  assert.ok(
    text.includes(s.sha256),
    "the hash is stated so the target can confirm",
  );
  assert.ok(text.includes(String(s.bytes)), "so is the byte count");
});

test("all six rules survive into the prompt", () => {
  const text = inlineOf('{"n":1}\n').toLowerCase();
  for (const rule of [
    "read the complete source session before acting",
    "treat it as historical context",
    "inspect the current workspace",
    "preserve uncommitted work",
    "continue from the exact stopping point",
    "do not redo completed investigation",
  ]) {
    assert.ok(text.includes(rule), `missing rule: ${rule}`);
  }
});

test("the prompt opens with an ordered set of actions, not a wall of rules", () => {
  const text = inlineOf('{"n":1}\n');
  const doThis = text.indexOf("Do this, in this order");
  const rules = text.indexOf("The rules");
  assert.ok(doThis > 0, "the target needs concrete first actions");
  assert.ok(doThis < rules, "actions should come before the rules");
});

test("the prompt forbids the status report agents default to", () => {
  const text = inlineOf('{"n":1}\n');
  assert.match(text, /Do not write a report/i);
  assert.match(text, /one or two lines/i);
  assert.match(
    text,
    /handoff \*is\* the instruction|do not wait for a fresh instruction/i,
  );
});

test("the prompt says what to do when the task was already finished", () => {
  assert.match(inlineOf('{"n":1}\n'), /already finished/i);
});

test("the prompt covers non-coding work explicitly", () => {
  assert.match(inlineOf('{"n":1}\n'), /notes|artifacts|conversation/i);
});

test("the prompt names both agents", () => {
  const text = inlineOf('{"n":1}\n');
  assert.match(text, /Codex/);
  assert.match(text, /Claude Code/);
});

test("the source pane is declared off limits and named", () => {
  const text = inlineOf('{"n":1}\n');
  assert.ok(text.includes("w6:p1"));
  assert.match(text, /do not send it input/i);
});

test("the sqlite export is explained when that strategy was used", () => {
  const session = {
    ...sessionOf('{"table":"session"}\n'),
    strategy: "sqlite",
    counts: { session: 1, message: 12, part: 40, todo: 1, event: 135 },
  };
  const text = renderInline({
    meta: {
      ...META,
      sourceKind: "opencode",
      sourceName: "opencode",
      strategy: "sqlite",
    },
    session,
  });
  assert.match(text, /table/i);
  assert.match(text, /message/);
  assert.ok(text.includes("12"));
});

test("the prompt ends with the sentinel, because that is the delivery marker", () => {
  const text = inlineOf('{"n":1}\n');
  assert.ok(
    text.trimEnd().endsWith(SENTINEL),
    "the marker must be the last thing on screen",
  );
  assert.equal(SENTINEL, "-- end of handoff, begin now --");
});

test("no reference to a handoff document survives", () => {
  const text = inlineOf('{"n":1}\n');
  assert.ok(!text.includes("HANDOFF.md"), "there is no document any more");
  assert.ok(!text.includes("SOURCE.json"));
});

test("the prose alone leaves real room for a transcript", () => {
  const overhead = inlineOf("").length;
  assert.ok(
    overhead < 5000,
    `prose overhead is ${overhead}; it must leave >25k for the transcript`,
  );
  assert.equal(PROMPT_BUDGET, 30000);
});

const { renderReference } = require("../lib/briefing.js");
const { PER_RANGE, MAX_LISTED } = require("../lib/ranges.js");

function bigSession(lines) {
  return {
    strategy: "file",
    nativePath: BIG_NATIVE_PATH,
    body: Buffer.alloc(0),
    bytes: 581_632,
    lines,
    sha256: "b".repeat(64),
    counts: null,
    readable: true,
  };
}

test("the reference prompt names the agent's own file and pins what to read", () => {
  const s = bigSession(3000);
  const text = renderReference({ meta: META, session: s });
  assert.match(text, /^You are taking over this session from \*\*Codex\*\*/);
  assert.ok(text.includes(s.nativePath), "the target needs the path");
  assert.ok(text.includes("3,000"), "the pinned line count");
  assert.ok(text.includes(s.sha256));
});

test("the reference prompt names the file, pins line bounds, and omits range lists", () => {
  const text = renderReference({ meta: META, session: bigSession(3000) });
  assert.ok(
    text.includes("Read lines 1 to 3,000"),
    "pins the line count bound",
  );
  assert.ok(text.includes(BIG_NATIVE_PATH), "includes the native path");
  assert.ok(!text.includes("1–1200"), "omits verbose line range enumerations");
});

test("reading past the pinned line is ruled out, because the file is live", () => {
  const text = renderReference({ meta: META, session: bigSession(3000) });
  assert.match(text, /do not read past line 3,000/i);
});

test("a very long session states line bounds and stays under prompt budget", () => {
  const s = bigSession(PER_RANGE * (MAX_LISTED + 25));
  const text = renderReference({ meta: META, session: s });
  assert.match(text, /do not read past line/i);
  assert.ok(
    text.length < PROMPT_BUDGET,
    `reference prompt is ${text.length}, over budget`,
  );
});

test("the reference prompt also ends with the sentinel", () => {
  const text = renderReference({ meta: META, session: bigSession(3000) });
  assert.ok(text.trimEnd().endsWith(SENTINEL));
});

test("the reference prompt carries the same six rules as the inline one", () => {
  const text = renderReference({
    meta: META,
    session: bigSession(3000),
  }).toLowerCase();
  for (const rule of [
    "read the complete source session before acting",
    "treat it as historical context",
    "preserve uncommitted work",
    "continue from the exact stopping point",
    "do not redo completed investigation",
  ]) {
    assert.ok(text.includes(rule), `missing rule: ${rule}`);
  }
});

const { build } = require("../lib/briefing.js");

function fileSessionOfSize(bytes) {
  const line = '{"pad":"' + "x".repeat(98) + '"}\n';
  const body = Buffer.from(line.repeat(Math.ceil(bytes / line.length)), "utf8");
  return {
    strategy: "file",
    nativePath: NATIVE_PATH,
    body,
    bytes: body.length,
    lines: body.toString("utf8").split("\n").length - 1,
    sha256: "c".repeat(64),
    counts: null,
    readable: true,
  };
}

test("a small session is delivered inline", () => {
  const built = build({ meta: META, session: fileSessionOfSize(2000) });
  assert.equal(built.mode, "inline");
  assert.deepEqual(built.markers, [SENTINEL]);
});

test("a large session switches to a reference, and says which file to look for", () => {
  const built = build({ meta: META, session: fileSessionOfSize(400_000) });
  assert.equal(built.mode, "reference");
  assert.deepEqual(built.markers, [SENTINEL, "rollout-1.jsonl"]);
});

test("both modes stay under the prompt budget, and well under the hard ceiling", () => {
  for (const bytes of [0, 1000, 20_000, 26_000, 30_000, 400_000, 14_000_000]) {
    const built = build({ meta: META, session: fileSessionOfSize(bytes) });
    assert.ok(
      built.text.length <= PROMPT_BUDGET,
      `${bytes}-byte session produced a ${built.text.length}-char prompt`,
    );
    assert.ok(
      built.text.length < 32_767,
      "the hard argv ceiling must never be reached",
    );
  }
});

test("the boundary is decided on the assembled prompt, not on an estimate", () => {
  // Walk the crossover and assert it is monotonic: once reference wins it never
  // goes back to inline. A mis-measured budget shows up here as a flip-flop.
  let seenReference = false;
  for (let bytes = 20_000; bytes <= 32_000; bytes += 500) {
    const mode = build({ meta: META, session: fileSessionOfSize(bytes) }).mode;
    if (mode === "reference") seenReference = true;
    else
      assert.equal(
        seenReference,
        false,
        `inline reappeared at ${bytes} bytes after reference`,
      );
  }
  assert.equal(
    seenReference,
    true,
    "somewhere in that walk it must stop fitting",
  );
});

test("an over-budget session that is not readable text yields no prompt at all", () => {
  const s = fileSessionOfSize(400_000);
  s.readable = false;
  assert.equal(
    build({ meta: META, session: s }),
    null,
    "the caller must report that complete context could not be retrieved",
  );
});

test("an unreadable session that fits inline is still fine: the bytes travel in the prompt", () => {
  const s = fileSessionOfSize(2000);
  s.readable = false;
  assert.equal(
    build({ meta: META, session: s }).mode,
    "inline",
    "readability only matters when the target has to open the file itself",
  );
});

test("briefing no longer offers the document-era API", () => {
  const briefing = require("../lib/briefing.js");
  assert.equal(briefing.kickoff, undefined);
  assert.equal(briefing.partsTable, undefined);
  assert.equal(briefing.render, undefined);
});

test("all agents receive the optimized, concise prompt layout", () => {
  for (const kind of ["claude", "codex", "pi", "opencode", "grok", "hermes"]) {
    const meta = { ...META, targetKind: kind, targetName: kind };
    const prompt = renderInline({ meta, session: sessionOf('{"n":1}\n') });
    assert.ok(
      prompt.length < 2500,
      `prompt for ${kind} should be under 2500 chars overhead`,
    );
    assert.ok(prompt.includes(SENTINEL));
  }
});
