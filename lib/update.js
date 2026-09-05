"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const { stateDir } = require("./paths.js");

const CURRENT_VERSION = "0.2.0";
const REPO_OWNER = "sanirudh17";
const REPO_NAME = "herdr-agent-handoff";
const INSTALL_SPEC = `${REPO_OWNER}/${REPO_NAME}`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Reinstalling means refetching the plugin from GitHub; even a small repo can
// stall on a slow network, but the picker is blocked while this runs, so cap
// it rather than hanging the handoff behind it.
const INSTALL_TIMEOUT_MS = 120000;

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
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    raw: clean,
  };
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
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      try {
        if (res.statusCode === 200) {
          const json = JSON.parse(body);
          const tag = json.tag_name || json.name;
          const version = tag ? tag.replace(/^v/i, "") : null;
          if (version) {
            writeCache(
              {
                lastCheckUnix: Date.now(),
                latestVersion: version,
                dismissedVersion: cache ? cache.dismissedVersion || null : null,
              },
              env,
            );
          }
        }
      } catch {
        // ignore
      }
    });
  });

  req.on("error", () => {});
  req.on("timeout", () => {
    req.destroy();
  });
}

function checkUpdateAsync(env = process.env) {
  const now = Date.now();
  const cache = readCache(env) || {};

  // Fresh cache (< 24h)
  if (cache.lastCheckUnix && now - cache.lastCheckUnix < CHECK_INTERVAL_MS) {
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
  INSTALL_SPEC,
  INSTALL_TIMEOUT_MS,
  isNewer,
  parseVersion,
  readCache,
  writeCache,
  dismissUpdate,
  checkUpdateAsync,
  triggerProbe,
  installCommand,
  installUpdate,
};

// The exact command the footer has always told users to run by hand.
// UPDATE_FAKE_INSTALL is the single test seam: a script run via node in place
// of `herdr plugin install …`. It is never set in production.
function installCommand(env = process.env) {
  if (env.UPDATE_FAKE_INSTALL) {
    return {
      bin: process.execPath,
      args: [env.UPDATE_FAKE_INSTALL, "plugin", "install", "-y", INSTALL_SPEC],
    };
  }
  return {
    bin: env.HERDR_BIN_PATH || "herdr",
    args: ["plugin", "install", "-y", INSTALL_SPEC],
  };
}

function installTimeoutMs(env = process.env) {
  const value = Number(env.UPDATE_INSTALL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : INSTALL_TIMEOUT_MS;
}

// Runs the upgrade the notice advertises and reports the outcome for the
// footer. Never throws: a failed upgrade must leave the picker usable, with
// the notice still in place so the user can retry or dismiss it.
function installUpdate(env = process.env) {
  const { bin, args } = installCommand(env);
  let res;
  try {
    res = spawnSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: installTimeoutMs(env),
    });
  } catch (err) {
    return { ok: false, message: describeInstallError(err, env) };
  }
  if (res.error)
    return { ok: false, message: describeInstallError(res.error, env) };
  if (res.status !== 0) {
    return { ok: false, message: lastLine(res.stderr || res.stdout) };
  }
  return { ok: true };
}

function describeInstallError(err, env = process.env) {
  const message = (err && err.message ? err.message : String(err)).trim();
  if (/ETIMEDOUT|timed out/i.test(message)) {
    return `install timed out after ${Math.round(installTimeoutMs(env) / 1000)}s`;
  }
  if (/ENOENT/i.test(message)) {
    return "herdr executable not found on PATH";
  }
  return lastLine(message);
}

function lastLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.length > 0 ? lines[lines.length - 1] : "install failed";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
