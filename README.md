# pi-clear

A [pi](https://github.com/earendil-works/pi) extension that adds a `/clear` command: start a fresh session **without losing your model**.

## Why?

Pi's built-in `/new` command starts a new session, but the new session resolves its model from pi's defaults chain — CLI arguments, scoped models, the saved default in settings, then the first available model with auth.

If you switched models mid-session — with `/model`, model cycling, or an extension — that choice is recorded as a `model_change` entry in the *current* session transcript, so `/new` never sees it. Your carefully chosen model quietly reverts to the default.

`/clear` starts an equally fresh session, then restores the model and thinking level you were using.

## Install

```sh
pi install npm:@gadenbuie/pi-clear
```

Or try it without installing:

```sh
pi -e npm:@gadenbuie/pi-clear
```

## Usage

```text
/clear
```

## Behavior

When `/clear` runs, the extension:

1. waits for the agent to become idle if needed
2. captures the active model and thinking level
3. starts a new session via `ctx.newSession()`
4. restores the captured model and thinking level in the new session
5. shows a warning if clearing is cancelled or the captured model can no longer be applied (e.g. its auth was removed)

Because the model is applied with `pi.setModel()`, it's recorded in the new session's transcript — so it also survives `/resume`.

## Notes

- `/clear` only registers the slash command; it does not bind a keyboard shortcut, so it won't conflict with other extensions (such as `pi-mono-clear`, which uses `Ctrl+Shift+L`).
- The model handoff happens through a small JSON file in the OS temp directory, validated against the previous session file. Stale files are harmless: they only apply when the session file matches.
- Like `/new`, `/clear` does not carry over conversation history, compaction summaries, or session name.

## How it works

pi tears down the current runtime when a session is replaced, and extension instances are recreated for the new session. Session-bound objects can't be reused across that boundary, and the post-switch context has no model setter. So `/clear` captures the model as plain data into a handoff file, and the new session's extension instance picks it up on `session_start` (reason `new`) and applies it with `pi.setModel()`. The handoff file records which session file issued it so it can never apply to the wrong session.

## Development

Load the extension directly for local testing:

```sh
pi -e ./index.ts
```

There's also an RPC smoke test that verifies the core behavior end-to-end: it starts pi in RPC mode, switches to a different model and thinking level, runs `/clear`, and asserts both survive the new session:

```sh
python3 scripts/rpc-smoke-test.py
```

## Related extensions

- [`pi-mono-clear`](https://github.com/emanuelcasco/pi-mono-extensions) — a `/clear` alias for `/new` (does not preserve the model)

## License

[MIT](LICENSE)
