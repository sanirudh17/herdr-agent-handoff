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

test("parseVersion extracts semver correctly", () => {
  assert.deepEqual(parseVersion("0.1.0"), { major: 0, minor: 1, patch: 0, raw: "0.1.0" });
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, raw: "1.2.3" });
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

  writeCache({ lastCheckUnix: Date.now(), latestVersion: "0.2.0" }, env);
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: true, version: "0.2.0" });

  dismissUpdate("0.2.0", env);
  const resAfterDismiss = checkUpdateAsync(env);
  assert.deepEqual(resAfterDismiss, { available: false });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale cache triggers a background probe but returns cached result", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  // Cache is 48 hours old — stale.
  writeCache({ lastCheckUnix: Date.now() - 48 * 60 * 60 * 1000, latestVersion: "0.2.0" }, env);
  const res = checkUpdateAsync(env);
  // Should still return the cached result while the probe runs in background.
  assert.deepEqual(res, { available: true, version: "0.2.0" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkUpdateAsync returns false when latest version matches current", () => {
  const { HERDR_PLUGIN_STATE_DIR, dir } = tmpEnv();
  const env = { HERDR_PLUGIN_STATE_DIR };
  writeCache({ lastCheckUnix: Date.now(), latestVersion: CURRENT_VERSION }, env);
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

  writeCache({ lastCheckUnix: Date.now(), latestVersion: "0.2.0" }, env);
  dismissUpdate("0.2.0", env);
  assert.deepEqual(checkUpdateAsync(env), { available: false });

  // Simulate a new release appearing.
  writeCache({ lastCheckUnix: Date.now(), latestVersion: "0.3.0" }, env);
  const res = checkUpdateAsync(env);
  assert.deepEqual(res, { available: true, version: "0.3.0" });

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
