const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolve, SourceContextUnavailable } = require("../lib/sources.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-home-"));
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const ID = "ae39a48c-52dd-48e6-a3cf-262b2ccb0f5f";
const BODY = '{"a":1}\n{"b":2}\n';

test("kind:path is used directly without searching", () => {
  const home = tmpHome();
  const file = writeFile(path.join(home, "anywhere", "session.jsonl"), BODY);
  const got = resolve({ agent: "pi", sessionRef: { kind: "path", value: file }, homedir: home, env: {} });
  assert.equal(got.strategy, "file");
  assert.equal(got.path, file);
  assert.equal(got.lines, 2);
  assert.equal(got.bytes, Buffer.byteLength(BODY));
});

test("claude resolves <id>.jsonl under any project directory", () => {
  const home = tmpHome();
  const file = writeFile(path.join(home, ".claude", "projects", "C--Users-x-proj", `${ID}.jsonl`), BODY);
  const got = resolve({ agent: "claude", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} });
  assert.equal(got.path, file);
});

test("claude honours CLAUDE_CONFIG_DIR", () => {
  const home = tmpHome();
  const alt = tmpHome();
  const file = writeFile(path.join(alt, "projects", "p", `${ID}.jsonl`), BODY);
  const got = resolve({
    agent: "claude", sessionRef: { kind: "id", value: ID }, homedir: home,
    env: { CLAUDE_CONFIG_DIR: alt },
  });
  assert.equal(got.path, file);
});

test("codex resolves rollout-<date>-<id>.jsonl under nested date directories", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(home, ".codex", "sessions", "2026", "07", "10", `rollout-2026-07-10T16-46-08-${ID}.jsonl`),
    BODY
  );
  const got = resolve({ agent: "codex", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} });
  assert.equal(got.path, file);
});

test("pi resolves <timestamp>_<id>.jsonl", () => {
  const home = tmpHome();
  const file = writeFile(
    path.join(home, ".pi", "agent", "sessions", "--C--proj--", `2026-07-24T17-10-59-546Z_${ID}.jsonl`),
    BODY
  );
  const got = resolve({ agent: "pi", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} });
  assert.equal(got.path, file);
});

test("grok resolves chat_history.jsonl inside a directory named for the session", () => {
  const home = tmpHome();
  const file = writeFile(path.join(home, ".grok", "sessions", "C%3A%5Cproj", ID, "chat_history.jsonl"), BODY);
  writeFile(path.join(home, ".grok", "sessions", "C%3A%5Cproj", ID, "announcement_state.json"), "{}");
  const got = resolve({ agent: "grok", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} });
  assert.equal(got.path, file);
});

test("opencode returns a sqlite descriptor rather than a file", () => {
  const home = tmpHome();
  const db = writeFile(path.join(home, ".local", "share", "opencode", "opencode.db"), "x");
  const got = resolve({
    agent: "opencode", sessionRef: { kind: "id", value: "ses_06af8a" }, homedir: home, env: {},
  });
  assert.equal(got.strategy, "sqlite");
  assert.equal(got.dbPath, db);
  assert.equal(got.sessionId, "ses_06af8a");
});

test("non-integrated kinds are refused outright", () => {
  const home = tmpHome();
  for (const agent of ["gemini", "agy", "cline", "kiro", "amp", "maki"]) {
    assert.throws(
      () => resolve({ agent, sessionRef: { kind: "id", value: ID }, homedir: home, env: {} }),
      (err) => {
        assert.ok(err instanceof SourceContextUnavailable);
        assert.match(err.reason, /no session identity/);
        return true;
      }
    );
  }
});

test("a missing session reference is refused", () => {
  const home = tmpHome();
  assert.throws(
    () => resolve({ agent: "claude", sessionRef: null, homedir: home, env: {} }),
    SourceContextUnavailable
  );
});

test("zero matches is a hard failure", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  assert.throws(
    () => resolve({ agent: "claude", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} }),
    SourceContextUnavailable
  );
});

test("more than one match is a hard failure rather than a guess", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), BODY);
  writeFile(path.join(home, ".claude", "projects", "b", `${ID}.jsonl`), BODY);
  assert.throws(
    () => resolve({ agent: "claude", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} }),
    (err) => {
      assert.match(err.reason, /more than one/);
      return true;
    }
  );
});

test("an empty transcript is a hard failure", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), "");
  assert.throws(
    () => resolve({ agent: "claude", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} }),
    SourceContextUnavailable
  );
});

test("a kind:path value that does not exist is a hard failure", () => {
  const home = tmpHome();
  assert.throws(
    () => resolve({
      agent: "pi", sessionRef: { kind: "path", value: path.join(home, "nope.jsonl") },
      homedir: home, env: {},
    }),
    SourceContextUnavailable
  );
});

test("best-effort agents match any recognised extension containing the id", () => {
  const home = tmpHome();
  const file = writeFile(path.join(home, ".factory", "sessions", `conv-${ID}.json`), BODY);
  const got = resolve({ agent: "droid", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} });
  assert.equal(got.path, file);
});

test("counts lines correctly when the file has no trailing newline", () => {
  const home = tmpHome();
  writeFile(path.join(home, ".claude", "projects", "a", `${ID}.jsonl`), '{"a":1}\n{"b":2}');
  const got = resolve({ agent: "claude", sessionRef: { kind: "id", value: ID }, homedir: home, env: {} });
  assert.equal(got.lines, 2);
});
