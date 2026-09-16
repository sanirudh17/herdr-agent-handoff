# Headless handoff

Automation can transfer a session without opening the target or mode pickers:

```sh
node bin/handoff-headless.js --target claude --mode focused --destination split
node bin/handoff-headless.js --target codex --mode full --destination tab
```

Run it from a Herdr pane action, where `HERDR_PANE_ID` identifies the source
pane. The declared `handoff-headless` action in `herdr-plugin.toml` supplies
that context; a plain shell without that variable is rejected safely.

`--target` is required and must be an installed Herdr agent kind. The default
mode is `focused`, and the default destination is `split`. The script delegates
to the same guarded handoff path as the interactive actions, so source context,
target readiness, and delivery confirmation remain unchanged.
