"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { extract, hasSqlite, SqliteUnavailable } = require("./source-sqlite.js");

const MAX_LINES = 1200;
const MAX_BYTES = 256 * 1024;
const KEEP = 20;
const READABLE_PROBE_BYTES = 64 * 1024;

// Mode 2 hands the target a path and tells it to read lines. That is only honest
// if the bytes at that path are lines. An unverified agent layout that resolves to
// a database or a binary blob fails here and the handoff reports that complete
// context could not be retrieved, rather than transferring something partial.
function isReadableText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const probe = buffer.subarray(0, READABLE_PROBE_BYTES);
  if (probe.includes(0x00)) return false;
  const text = new TextDecoder("utf8", { fatal: false }).decode(probe);
  if (text.includes("�")) return false;
  return text.includes("\n");
}

function chunk(buffer, opts = {}) {
  const { maxLines = MAX_LINES, maxBytes = MAX_BYTES } = opts;
  if (buffer.length === 0) return [];

  const parts = [];
  let start = 0;
  let lines = 0;
  let cursor = 0;

  while (cursor < buffer.length) {
    const nl = buffer.indexOf(0x0a, cursor);
    const end = nl === -1 ? buffer.length : nl + 1;
    lines += 1;
    const wouldExceedBytes = end - start > maxBytes && lines > 1;

    if (wouldExceedBytes) {
      // Close the part before this line.
      parts.push({ buffer: buffer.subarray(start, cursor), lines: lines - 1 });
      start = cursor;
      lines = 1;
    }

    cursor = end;

    if (lines >= maxLines) {
      parts.push({ buffer: buffer.subarray(start, cursor), lines });
      start = cursor;
      lines = 0;
    }
  }

  if (start < buffer.length) {
    parts.push({ buffer: buffer.subarray(start), lines });
  }
  return parts;
}

function makeReadOnly(file) {
  try {
    // On Windows, Node maps the missing write bit to the ReadOnly attribute.
    fs.chmodSync(file, 0o444);
  } catch {
    // best effort; the briefing also tells the target not to write here
  }
}

function stamp(now) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function write({ resolved, meta, baseDir, now = new Date() }) {
  const dir = path.join(baseDir, `${stamp(now)}-${meta.sourceKind}-to-${meta.targetKind}`);
  const sessionDir = path.join(dir, "session");
  fs.mkdirSync(sessionDir, { recursive: true });

  let body;
  let counts = null;
  let nativePath = resolved.path || null;

  if (resolved.strategy === "sqlite") {
    if (!hasSqlite()) {
      throw new SqliteUnavailable("node:sqlite is unavailable; Node 22.5 or newer is required");
    }
    const exported = extract({
      dbPath: resolved.dbPath,
      sessionId: resolved.sessionId,
      workDir: dir,
    });
    body = fs.readFileSync(exported.jsonlPath);
    counts = exported.counts;
    nativePath = resolved.dbPath;
    fs.rmSync(exported.jsonlPath, { force: true });
  } else {
    body = fs.readFileSync(resolved.path);
  }

  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const chunks = chunk(body);
  const parts = [];
  let cursorLine = 1;

  chunks.forEach((part, index) => {
    const name = `part-${String(index + 1).padStart(3, "0")}.jsonl`;
    const file = path.join(sessionDir, name);
    fs.writeFileSync(file, part.buffer);
    makeReadOnly(file);
    parts.push({
      file,
      name: `session/${name}`,
      lines: part.lines,
      bytes: part.buffer.length,
      firstLine: cursorLine,
      lastLine: cursorLine + part.lines - 1,
    });
    cursorLine += part.lines;
  });

  const totalLines = parts.reduce((sum, p) => sum + p.lines, 0);

  const sourceJson = {
    source_agent: meta.sourceKind,
    source_agent_name: meta.sourceName,
    session_id: meta.sessionId,
    strategy: resolved.strategy,
    native_path: nativePath,
    sha256,
    total_bytes: body.length,
    total_lines: totalLines,
    row_counts: counts,
    source_pane_id: meta.sourcePaneId,
    workspace_id: meta.workspaceId,
    tab_id: meta.tabId,
    cwd: meta.cwd,
    destination: meta.destination,
    target_agent: meta.targetKind,
    target_agent_name: meta.targetName,
    snapshot_utc: now.toISOString(),
    parts: parts.map((p) => ({
      name: p.name, lines: p.lines, bytes: p.bytes,
      first_line: p.firstLine, last_line: p.lastLine,
    })),
  };

  const sourceFile = path.join(dir, "SOURCE.json");
  fs.writeFileSync(sourceFile, JSON.stringify(sourceJson, null, 2) + "\n");
  makeReadOnly(sourceFile);

  return {
    dir,
    parts,
    totalLines,
    totalBytes: body.length,
    sha256,
    counts,
    snapshotUtc: sourceJson.snapshot_utc,
  };
}

function prune(baseDir, keep = KEEP) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const sorted = entries
    .map((e) => ({ name: e.name, full: path.join(baseDir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const doomed = sorted.slice(0, Math.max(0, sorted.length - keep));
  const removed = [];
  for (const dir of doomed) {
    try {
      fs.rmSync(dir.full, { recursive: true, force: true });
      removed.push(dir.full);
    } catch {
      // leave it; pruning is best effort
    }
  }
  return removed;
}

module.exports = {
  chunk, write, prune, isReadableText, MAX_LINES, MAX_BYTES, READABLE_PROBE_BYTES,
};
