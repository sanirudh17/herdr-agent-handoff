# Headless handoff

Automation can transfer a session without opening the target or mode pickers.
This is automation-only: flags (or env, see below) must name the target, so
invoking the bare `handoff-headless` action with no target exits `2` with
usage on `stderr` instead of guessing.

```sh
node bin/handoff-headless.js --target claude --mode focused --destination split
node bin/handoff-headless.js --target codex --mode full --destination tab
# --flag=value works too:
node bin/handoff-headless.js --target=claude --mode=full --destination=tab
```

Every flag has an env fallback so dispatchers and `herdr plugin action invoke`
callers can run with no CLI args (flag wins over env):

| flag                       | env                                                                                           | default   |
| -------------------------- | --------------------------------------------------------------------------------------------- | --------- |
| `--target KIND`            | `HERDR_HANDOFF_TARGET`                                                                        | required  |
| `--destination split\|tab` | `HERDR_HANDOFF_DESTINATION`                                                                   | `split`   |
| `--mode focused\|full`     | `HERDR_HANDOFF_MODE` (`HANDOFF_MODE` also read; legacy `HANDOFF_HANDOFF_MODE` still honoured) | `focused` |

```sh
HERDR_HANDOFF_TARGET=claude node bin/handoff-headless.js
```

The source pane resolves as `HERDR_PANE_ID` when a dispatcher sets it
explicitly, otherwise the action's focused pane from `HERDR_PLUGIN_CONTEXT_JSON`.
A plain shell with neither is rejected safely with the standard
not-an-agent-pane message, and the source pane is never written to on failure.

`--target` must be an installed Herdr agent kind: unknown kinds are rejected
before anything is created. The script delegates to the same guarded handoff
path as the interactive actions, so source context, target readiness, and
delivery confirmation remain unchanged.
