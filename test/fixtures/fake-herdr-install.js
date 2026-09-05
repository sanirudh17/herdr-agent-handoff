#!/usr/bin/env node
"use strict";

// Test stand-in for `herdr plugin install …`. Controlled by environment so the
// update-install path is exercisable on every platform without touching a real
// Herdr setup (which, on a dev machine, would replace a linked plugin with a
// marketplace copy):
//   FAKE_HERDR_INSTALL_FAIL=1  -> exit 1 with an error on stderr
//   FAKE_HERDR_INSTALL_HANG=1  -> never exit (exercises the install timeout)
// otherwise                         -> exit 0 with a line on stdout
if (process.env.FAKE_HERDR_INSTALL_HANG === "1") {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_HERDR_INSTALL_FAIL === "1") {
  process.stderr.write(
    "herdr plugin install failed: simulated failure for tests\n",
  );
  process.exit(1);
} else {
  process.stdout.write(
    `installed ${process.argv.slice(2).join(" ") || "(no args)"}\n`,
  );
  process.exit(0);
}
