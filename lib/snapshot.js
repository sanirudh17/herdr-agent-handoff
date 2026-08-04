"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  extractToBuffer,
  hasSqlite,
  SqliteUnavailable,
} = require("./source-sqlite.js");

const READABLE_PROBE_BYTES = 64 * 1024;

// Mode 2 hands the target a path and tells it to read lines. That is only honest
// if the bytes at that path are lines. An unverified agent layout that resolves to
// a database or a binary blob fails here and the handoff reports that complete
// context could not be retrieved, rather than transferring something partial.
// A target agent reads the transcript as lines, so a file is usable when it is
// valid UTF-8 (a fatal decode rejects binary with a wrong label), contains no
// NUL bytes (the strongest binary marker) and has at least one newline in the
// probe. A literal U+FFFD is *not* disqualifying: real transcripts contain it
// when an agent captured output that was already mangled, and it decodes fine.
function isReadableText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const probe = buffer.subarray(0, READABLE_PROBE_BYTES);
  if (probe.includes(0x00)) return false;
  try {
    new TextDecoder("utf8", { fatal: true }).decode(probe);
  } catch {
    return false;
  }
  return probe.includes(0x0a);
}

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  if (buffer[buffer.length - 1] !== 0x0a) count += 1;
  return count;
}

// Nothing here writes. The transcript stays where its own agent put it; all we
// need is its size, its line count and a hash, so the prompt can pin exactly the
// session as it stood even though the file is live.
function measure({ resolved }) {
  if (resolved.strategy === "sqlite") {
    if (!hasSqlite()) {
      throw new SqliteUnavailable(
        "node:sqlite is unavailable; Node 22.5 or newer is required",
      );
    }
    const exported = extractToBuffer({
      dbPath: resolved.dbPath,
      sessionId: resolved.sessionId,
    });
    return {
      strategy: "sqlite",
      nativePath: resolved.dbPath,
      body: exported.body,
      bytes: exported.body.length,
      lines: countLines(exported.body),
      sha256: crypto.createHash("sha256").update(exported.body).digest("hex"),
      counts: exported.counts,
      readable: isReadableText(exported.body),
    };
  }

  // A store that only lives inside another agent's database (grok's per-session
  // search index): the body is delivered by the resolver, there is no file to
  // point a target at, and nothing is written anywhere.
  if (resolved.strategy === "sqlite-content") {
    const body = Buffer.isBuffer(resolved.body)
      ? resolved.body
      : Buffer.from(String(resolved.body || ""), "utf8");
    if (body.length === 0) {
      throw new Error("the session body is empty");
    }
    return {
      strategy: "sqlite-content",
      nativePath: null,
      body,
      bytes: body.length,
      lines: countLines(body),
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      counts: null,
      readable: isReadableText(body),
    };
  }

  const body = fs.readFileSync(resolved.path);
  return {
    strategy: "file",
    nativePath: resolved.path,
    body,
    bytes: body.length,
    lines: countLines(body),
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    counts: null,
    readable: isReadableText(body),
  };
}

module.exports = { measure, isReadableText, countLines, READABLE_PROBE_BYTES };
