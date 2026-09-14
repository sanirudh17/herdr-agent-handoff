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
