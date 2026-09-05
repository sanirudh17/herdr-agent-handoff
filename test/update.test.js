"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  isNewer,
  parseVersion,
  readCache,
  writeCache,
  dismissUpdate,
  checkUpdateAsync,
  CURRENT_VERSION,
} = require("../lib/update.js");

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-update-test-"));
  return { HERDR_PLUGIN_STATE_DIR: dir, dir };
}

// A version guaranteed newer than CURRENT_VERSION, so these tests survive
// future bumps (a hardcoded "next" version silently becomes current).
function newer(bump = 1) {
  const p = parseVersion(CURRENT_VERSION);
  return `${p.major}.${p.minor}.${p.patch + bump}`;
}

test("parseVersion extracts semver correctly", () => {
  assert.deepEqual(parseVersion("0.1.0"), {
    major: 0,
    minor: 1,
    patch: 0,
    raw: "0.1.0",
  });
  assert.deepEqual(parseVersion("v1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    raw: "1.2.3",
  });
  assert.equal(parseVersion("invalid"), null);
});

test("isNewer compares versions accurately", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.0.9", "0.1.0"), false);
});

test("readCache and writeCache persist cache to disk", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };

  writeCache({ lastCheckUnix: 1000, latestVersion: "0.2.0" }, env);
  const cache = readCache(env);
  assert.equal(cache.lastCheckUnix, 1000);
  assert.equal(cache.latestVersion, "0.2.0");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("dismissUpdate updates dismissedVersion in cache", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };

  writeCache({ lastCheckUnix: Date.now(), latestVersion: "0.2.0" }, env);
  dismissUpdate("0.2.0", env);

  const cache = readCache(env);
  assert.equal(cache.dismissedVersion, "0.2.0");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkUpdateAsync returns available when cached version is newer and not dismissed", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  const next = newer();

  writeCache({ lastCheckUnix: Date.now(), latestVersion: next }, env);
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: true, version: next });

  dismissUpdate(next, env);
  const resAfterDismiss = checkUpdateAsync(env);
  assert.deepEqual(resAfterDismiss, { available: false });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale cache triggers a background probe but returns cached result", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  // Cache is 48 hours old — stale.
  writeCache(
    { lastCheckUnix: Date.now() - 48 * 60 * 60 * 1000, latestVersion: newer() },
    env,
  );
  const res = checkUpdateAsync(env);
  // Should still return the cached result while the probe runs in background.
  assert.deepEqual(res, { available: true, version: newer() });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkUpdateAsync returns false when latest version matches current", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  writeCache(
    { lastCheckUnix: Date.now(), latestVersion: CURRENT_VERSION },
    env,
  );
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkUpdateAsync returns false when latest version is older than current", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  writeCache({ lastCheckUnix: Date.now(), latestVersion: "0.0.1" }, env);
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dismissing one version does not suppress a newer version", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };

  writeCache({ lastCheckUnix: Date.now(), latestVersion: newer() }, env);
  dismissUpdate(newer(), env);
  assert.deepEqual(checkUpdateAsync(env), { available: false });

  // Simulate a new release appearing.
  writeCache({ lastCheckUnix: Date.now(), latestVersion: newer(2) }, env);
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: true, version: newer(2) });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkUpdateAsync returns false with no cache", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CURRENT_VERSION is a valid semver string", () => {
  assert.match(CURRENT_VERSION, /^\d+\.\d+\.\d+$/);
});

test("package.json, herdr-plugin.toml and CURRENT_VERSION agree", () => {
  // The update banner compares the GitHub release tag against
  // CURRENT_VERSION, while users and Herdr see package.json and the
  // manifest. If any of the three drifts, the popup fires wrongly or not
  // at all — so the release process must keep them identical.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const manifest = fs.readFileSync(
    path.join(__dirname, "..", "herdr-plugin.toml"),
    "utf8",
  );
  const manifestVersion = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(manifestVersion, "herdr-plugin.toml must declare a version");
  assert.equal(CURRENT_VERSION, pkg.version);
  assert.equal(CURRENT_VERSION, manifestVersion);
});

// --- one-key install (the picker's `i` action) ------------------------------

const INSTALL_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "fake-herdr-install.js",
);

test("installCommand runs the documented upgrade command", () => {
  const { installCommand, INSTALL_SPEC } = require("../lib/update.js");
  assert.deepEqual(installCommand({}), {
    bin: "herdr",
    args: ["plugin", "install", "-y", INSTALL_SPEC],
  });
  assert.equal(INSTALL_SPEC, "sanirudh17/herdr-agent-handoff");
});

test("installCommand honours HERDR_BIN_PATH like the rest of the plugin", () => {
  const { installCommand } = require("../lib/update.js");
  const cmd = installCommand({ HERDR_BIN_PATH: "/opt/herdr" });
  assert.equal(cmd.bin, "/opt/herdr");
  assert.deepEqual(cmd.args.slice(0, 2), ["plugin", "install"]);
});

test("installUpdate reports success when herdr exits zero", () => {
  const { installUpdate } = require("../lib/update.js");
  const res = installUpdate({ UPDATE_FAKE_INSTALL: INSTALL_FIXTURE });
  assert.deepEqual(res, { ok: true });
});

test("installUpdate reports the failure reason without throwing", () => {
  const { installUpdate } = require("../lib/update.js");
  const res = installUpdate({
    UPDATE_FAKE_INSTALL: INSTALL_FIXTURE,
    FAKE_HERDR_INSTALL_FAIL: "1",
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /simulated failure/);
});

test("installUpdate gives up after the timeout instead of hanging", () => {
  const { installUpdate } = require("../lib/update.js");
  const res = installUpdate({
    UPDATE_FAKE_INSTALL: INSTALL_FIXTURE,
    FAKE_HERDR_INSTALL_HANG: "1",
    UPDATE_INSTALL_TIMEOUT_MS: "500",
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /timed out/);
});

test("installUpdate reports a missing herdr binary readably", () => {
  const { installUpdate } = require("../lib/update.js");
  const res = installUpdate({
    HERDR_BIN_PATH: path.join(os.tmpdir(), "no-such-herdr-binary"),
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found on PATH/);
});
