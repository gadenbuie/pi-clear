# pi-clear

A [pi](https://github.com/earendil-works/pi) extension that adds `/clear`: start a fresh session **without losing your model**.

> **`/hand-off` and `/hand-off-chain` moved.** They now live in [`@grrrck/pi-hand-off`](https://github.com/gadenbuie/pi-hand-off) (`/hand-off-chain` is now `/hand-off-relay`). Install it with `pi install npm:@grrrck/pi-hand-off`. See [Moving to pi-hand-off](#moving-to-pi-hand-off).

## Why?

Pi's built-in `/new` command starts a new session, but the new session resolves its model from pi's defaults chain — CLI arguments, scoped models, the saved default in settings, then the first available model with auth.

If you switched models mid-session — with `/model`, model cycling, or an extension — that choice is recorded as a `model_change` entry in the *current* session transcript, so `/new` never sees it. Your carefully chosen model quietly reverts to the default.

`/clear` starts an equally fresh session, then restores the model and thinking level you were using.

## Install

```sh
pi install npm:@grrrck/pi-clear
```

Or try it without installing:

```sh
pi -e npm:@grrrck/pi-clear
```

## Usage

```text
/clear
```

When `/clear` runs, the extension:

1. waits for the agent to become idle if needed, notifying you that it's waiting
2. captures the active model and thinking level
3. starts a new session via `ctx.newSession()`
4. restores the captured model and thinking level in the new session
5. shows a warning if clearing is cancelled or the captured model can no longer be applied (e.g. its auth was removed)

Because the model is applied with `pi.setModel()`, it's recorded in the new session's transcript — so it also survives `/resume`.

## Notes

- `/clear` only registers the slash command; it does not bind a keyboard shortcut, so it won't conflict with other extensions (such as `pi-mono-clear`, which uses `Ctrl+Shift+L`).
- The model handoff is in-process only: it is invisible to other pi processes and is discarded if pi exits between clearing and restoring.
- The one file pi-clear writes is `<agent-dir>/pi-clear-moved-notice`, so the "`/hand-off` moved" notice shows only once. It's skipped when `/hand-off` is already available, and delete the file to see it again.
- Like `/new`, `/clear` does not carry over conversation history, compaction summaries, or session name.

## Moving to pi-hand-off

Versions up to 0.5.0 also shipped `/hand-off`. If you use it:

1. `pi install npm:@grrrck/pi-hand-off`
2. Remove `@grrrck/pi-clear` if you no longer want `/clear`; the two packages can be installed side by side.
3. Settings in `<agent-dir>/pi-clear.json` are still read by `pi-hand-off` when `pi-hand-off.json` doesn't exist. You can rename the file.

`/hand-off-chain` was never published to npm; it is now `/hand-off-relay` in `pi-hand-off`.

## How it works

pi tears down the current runtime when a session is replaced, and extension instances are recreated for the new session. Session-bound objects can't be reused across that boundary, and the post-switch context has no model setter — but the replacement happens within the same process. So `/clear` captures the model and thinking level as plain data in a `globalThis` property, and the new session's extension instance consumes it on `session_start` (reason `new`) and applies it with `pi.setModel()`. The handoff is consumed exactly once, so it can never leak into a later session.

## Development

Load the extension directly for local testing:

```sh
pi -e ./index.ts
```

```sh
node --test scripts/clear.test.mjs   # offline, mocked pi APIs
python3 scripts/rpc-smoke-test.py    # end-to-end via pi in RPC mode
```

The RPC smoke test needs at least two models with configured auth; it only drives local RPC state and makes no model requests. The `node --test` script needs neither auth nor a pi process.

## Related extensions

- [`@grrrck/pi-hand-off`](https://github.com/gadenbuie/pi-hand-off) — `/hand-off` and `/hand-off-relay`
- [`pi-mono-clear`](https://github.com/emanuelcasco/pi-mono-extensions) — a `/clear` alias for `/new` (does not preserve the model)

## License

[MIT](LICENSE)
