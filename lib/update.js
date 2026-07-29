"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { stateDir } = require("./paths.js");

const CURRENT_VERSION = "0.1.0";
const REPO_OWNER = "sanirudh17";
const REPO_NAME = "herdr-agent-handoff";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheFile(env = process.env) {
  const dir = stateDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return path.join(dir, "update-cache.json");
}

function readCache(env = process.env) {
  try {
    const file = cacheFile(env);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data, env = process.env) {
  try {
    const file = cacheFile(env);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function parseVersion(vStr) {
  if (!vStr) return null;
  const clean = String(vStr).replace(/^v/i, "").trim();
  const parts = clean.split(".").map((x) => parseInt(x, 10));
  if (parts.length < 1 || isNaN(parts[0])) return null;
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: clean };
}

function isNewer(latestStr, currentStr = CURRENT_VERSION) {
  const latest = parseVersion(latestStr);
  const current = parseVersion(currentStr);
  if (!latest || !current) return false;
  if (latest.major > current.major) return true;
  if (latest.major < current.major) return false;
  if (latest.minor > current.minor) return true;
  if (latest.minor < current.minor) return false;
  return latest.patch > current.patch;
}

function dismissUpdate(version, env = process.env) {
  const cache = readCache(env) || {};
  cache.dismissedVersion = version;
  writeCache(cache, env);
}

function triggerProbe(cache, env = process.env) {
  const options = {
    hostname: "api.github.com",
    path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    headers: { "User-Agent": "agent-handoff" },
    timeout: 3000,
  };

  const req = https.get(options, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => {
      try {
        if (res.statusCode === 200) {
          const json = JSON.parse(body);
          const tag = json.tag_name || json.name;
          const version = tag ? tag.replace(/^v/i, "") : null;
          if (version) {
            writeCache({
              lastCheckUnix: Date.now(),
              latestVersion: version,
              dismissedVersion: cache ? cache.dismissedVersion || null : null,
            }, env);
          }
        }
      } catch {
        // ignore
      }
    });
  });

  req.on("error", () => {});
  req.on("timeout", () => { req.destroy(); });
}

function checkUpdateAsync(env = process.env) {
  const now = Date.now();
  const cache = readCache(env) || {};

  // Fresh cache (< 24h)
  if (cache.lastCheckUnix && (now - cache.lastCheckUnix < CHECK_INTERVAL_MS)) {
    if (cache.latestVersion && isNewer(cache.latestVersion, CURRENT_VERSION)) {
      if (cache.dismissedVersion !== cache.latestVersion) {
        return { available: true, version: cache.latestVersion };
      }
    }
    return { available: false };
  }

  // Stale or missing cache: trigger background probe
  triggerProbe(cache, env);

  // Return cached result if available while probe runs in background
  if (cache.latestVersion && isNewer(cache.latestVersion, CURRENT_VERSION)) {
    if (cache.dismissedVersion !== cache.latestVersion) {
      return { available: true, version: cache.latestVersion };
    }
  }
  return { available: false };
}

module.exports = {
  CURRENT_VERSION,
  isNewer,
  parseVersion,
  readCache,
  writeCache,
  dismissUpdate,
  checkUpdateAsync,
  triggerProbe,
};
