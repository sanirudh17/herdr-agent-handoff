"use strict";

const { spawnSync } = require("node:child_process");

class HerdrCliError extends Error {
  constructor(message, { code = null, stderr = "" } = {}) {
    super(message);
    this.name = "HerdrCliError";
    this.code = code;
    this.stderr = stderr;
  }
}

function binPath(env = process.env) {
  return env.HERDR_BIN_PATH || "herdr";
}

function lastJsonLine(text) {
  // Strip a UTF-8 BOM: Herdr's output picks one up on some Windows paths, and
  // JSON.parse rejects it outright.
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

function run(args, opts = {}) {
  const { json = true, env = process.env } = opts;
  const res = spawnSync(binPath(env), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  if (res.error) {
    throw new HerdrCliError(`could not run herdr: ${res.error.message}`);
  }

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  // Herdr prints success envelopes to stdout but *error* envelopes to stderr, so
  // both have to be searched. Reading only stdout silently threw away every real
  // error code, leaving callers unable to tell one failure from another.
  const envelope = lastJsonLine(stdout) || lastJsonLine(stderr);

  if (envelope && envelope.error) {
    const { code = null, message = "herdr reported an error" } = envelope.error;
    throw new HerdrCliError(message, { code, stderr });
  }

  if (res.status !== 0) {
    throw new HerdrCliError(
      `herdr ${args.join(" ")} exited with status ${res.status}`,
      { stderr },
    );
  }

  if (!json) return stdout;

  if (!envelope || envelope.result === undefined) {
    throw new HerdrCliError(`herdr ${args.join(" ")} returned no JSON result`, {
      stderr,
    });
  }

  return envelope.result;
}

module.exports = { run, binPath, HerdrCliError };
