"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildSummaryRequest,
  generateFocusedSummary,
  summarizeSession,
  validateSummary,
} = require("../lib/focused.js");

const META = {
  sessionId: "s1",
  cwd: "C:\\work",
  snapshotUtc: "2026-07-26T09:30:00.000Z",
};

test("the summary request is strict and names the output file", () => {
  const out = path.join(os.tmpdir(), "handoff.md");
  const text = buildSummaryRequest({ meta: META, outputPath: out });
  assert.match(text, /Do not modify files/);
  assert.match(text, /Do not continue implementation/);
  assert.match(text, /Current objective/);
  assert.match(text, /Completed work/);
  assert.match(text, /Remaining work/);
  assert.match(text, /Pitfalls \/ do not redo/);
  assert.match(text, /Relevant files/);
  assert.ok(text.includes(out));
});

test("validateSummary rejects empty output", () => {
  assert.throws(() => validateSummary("   "), /empty summary/);
  assert.equal(validateSummary("  hello  "), "hello");
});

test("generateFocusedSummary prompts the source and reads the file it writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focused-"));
  const out = path.join(dir, "handoff.md");
  const calls = [];
  const call = (args) => {
    calls.push(args);
    fs.writeFileSync(out, "# Focused Handoff\n\nDone.\n");
    return {};
  };
  const summary = await generateFocusedSummary({
    call,
    sourcePaneId: "w5:p1",
    meta: META,
    env: { ...process.env, HANDOFF_FOCUSED_TIMEOUT_MS: "2000" },
    outputPath: out,
    pollMs: 5,
  });
  assert.match(summary, /Done/);
  assert.ok(
    calls.some(
      (a) => a[0] === "agent" && a[1] === "prompt" && a[2] === "w5:p1",
    ),
    "the source pane is prompted",
  );
});

test("generateFocusedSummary times out instead of hanging", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focused-"));
  const out = path.join(dir, "missing.md");
  await assert.rejects(
    generateFocusedSummary({
      call: () => ({}),
      sourcePaneId: "w5:p1",
      meta: META,
      env: process.env,
      outputPath: out,
      timeoutMs: 30,
      pollMs: 5,
    }),
    /did not write a focused summary/,
  );
});

test("generateFocusedSummary requires a caller and a source", async () => {
  await assert.rejects(
    generateFocusedSummary({ sourcePaneId: "w5:p1", meta: META }),
    /no Herdr caller/,
  );
  await assert.rejects(
    generateFocusedSummary({ call: () => ({}), meta: META }),
    /no source pane/,
  );
});

function sessionOf(lines) {
  const body = Buffer.from(lines.join("\n") + "\n", "utf8");
  return {
    strategy: "file",
    nativePath: "C:\\x\\rollout-1.jsonl",
    body,
    bytes: body.length,
    lines: lines.length,
    sha256: "a".repeat(64),
    counts: null,
    readable: true,
  };
}

function sessionOfBody(text, strategy = "file") {
  const body = Buffer.from(text, "utf8");
  return {
    strategy,
    nativePath: "C:\\x\\rollout-1.jsonl",
    body,
    bytes: body.length,
    lines: text.split("\n").length - 1,
    sha256: "a".repeat(64),
    counts: null,
    readable: true,
  };
}

test("summarizeSession derives a structured summary without prompting anyone", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf([
      JSON.stringify({ role: "user", text: "Fix the widget in lib/widget.js" }),
      JSON.stringify({ role: "assistant", text: "Reproduced; patching now." }),
      JSON.stringify({ role: "user", text: "Also keep the change small." }),
    ]),
  });
  assert.match(summary, /Current objective/);
  assert.ok(summary.includes("Fix the widget"));
  assert.ok(summary.includes("keep the change small"));
  assert.match(summary, /Relevant files/);
  assert.ok(summary.includes("lib/widget.js"));
});

test("summarizeSession never embeds the full transcript body", () => {
  const marker = "focused-local-must-not-leak-67890";
  const lines = [
    JSON.stringify({ role: "user", text: "hello" }),
    JSON.stringify({ role: "assistant", data: { blob: marker.repeat(20) } }),
  ];
  const summary = summarizeSession({ meta: META, session: sessionOf(lines) });
  assert.ok(!summary.includes(marker));
});

test("summarizeSession degrades gracefully on unscannable transcripts", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf(['{"i":0}', '{"i":1}', "not json at all"]),
  });
  assert.match(summary, /Current objective/);
  assert.match(summary, /Not identified/);
});

test("summarizeSession refuses an empty session", () => {
  assert.throws(
    () => summarizeSession({ meta: META, session: null }),
    /no resolved session/,
  );
  assert.throws(
    () =>
      summarizeSession({
        meta: META,
        session: { ...sessionOf(['{"a":1}']), body: Buffer.alloc(0) },
      }),
    /no resolved session/,
  );
});

test("claude-style nested messages with content blocks are read", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf([
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Fix the toggle in src/ui.ts" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", name: "Glob", input: { pattern: "src/**" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Also keep it small." }],
        },
      }),
    ]),
  });
  assert.ok(summary.includes("Fix the toggle"));
  assert.ok(summary.includes("keep it small"));
  assert.ok(summary.includes("src/ui.ts"));
  assert.ok(!summary.includes("tool_use"));
});

test("claude file-history snapshots and summaries do not pollute excerpts", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf([
      JSON.stringify({ type: "summary", summary: "Settings bug hunt" }),
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "1",
        snapshot: { a: 1 },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Go." },
      }),
    ]),
  });
  assert.ok(summary.includes("Go."));
});

test("a claude summary stands in when no user message is found", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf([
      JSON.stringify({ type: "summary", summary: "Settings bug hunt" }),
    ]),
  });
  assert.ok(summary.includes("Settings bug hunt"));
});

test("codex rollout items with input/output blocks are read", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf([
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "C:\\w", session_id: "abc" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Repair the build" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Build is green." }],
        },
      }),
    ]),
  });
  assert.ok(summary.includes("Repair the build"));
  assert.ok(summary.includes("Build is green."));
});

test("opencode sqlite-export envelopes attribute parts to messages", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOfBody(
      [
        JSON.stringify({
          table: "session",
          row: { id: "s1", title: "Toggle fix", directory: "C:\\w" },
        }),
        JSON.stringify({
          table: "message",
          row: { id: "m1", session_id: "s1", data: { role: "user" } },
        }),
        JSON.stringify({
          table: "part",
          row: {
            id: "p1",
            message_id: "m1",
            session_id: "s1",
            type: "text",
            data: { type: "text", text: "Fix it in lib/a.js" },
          },
        }),
        JSON.stringify({
          table: "part",
          row: {
            id: "p2",
            message_id: "m1",
            session_id: "s1",
            type: "tool",
            data: { type: "tool", tool: "bash", command: "x".repeat(5000) },
          },
        }),
      ].join("\n") + "\n",
      "sqlite",
    ),
  });
  assert.ok(summary.includes("Fix it in lib/a.js"));
  assert.ok(summary.includes("lib/a.js"));
});

test("an opencode session title stands in when no user message is found", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOfBody(
      JSON.stringify({
        table: "session",
        row: { id: "s1", title: "Toggle fix", directory: "C:\\w" },
      }) + "\n",
      "sqlite",
    ),
  });
  assert.ok(summary.includes("Toggle fix"));
});

test("a whole-file cline messages array is read", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOfBody(
      JSON.stringify([
        { role: "user", content: "Cline, fix the leak" },
        { role: "assistant", content: "Patched src/leak.ts" },
      ]),
    ),
  });
  assert.ok(summary.includes("fix the leak"));
  assert.ok(summary.includes("src/leak.ts"));
});

test("encrypted blobs and oversized tool dumps are skipped, not fatal", () => {
  const summary = summarizeSession({
    meta: META,
    session: sessionOf([
      JSON.stringify({
        type: "reasoning",
        status: "completed",
        encrypted_content: "Q-PaDgE4q-".repeat(100),
      }),
      JSON.stringify({ role: "user", content: "Short ask." }),
      JSON.stringify({ role: "user", text: "y" }),
    ]),
  });
  assert.ok(summary.includes("Short ask."));
  assert.ok(!summary.includes("Q-PaDgE4q"));
});
