"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function newId() {
  return crypto.randomBytes(9).toString("base64url");
}

function requestPath(dir, id) {
  return path.join(dir, `${id}.request.json`);
}

function resultPath(dir, id) {
  return path.join(dir, `${id}.result.json`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForResult(file, opts = {}) {
  const { timeoutMs = 300000, pollMs = 60 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return readJson(file);
    } catch {
      // absent or still being written
    }
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

function cleanup(files) {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
}

module.exports = { newId, requestPath, resultPath, writeJson, readJson, waitForResult, cleanup };
