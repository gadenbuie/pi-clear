# pi-clear

A [pi](https://github.com/earendil-works/pi) extension with two commands:

- `/clear` — start a fresh session **without losing your model**
- `/hand-off` — hand the conversation to another model with a prompt written by the current agent

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
/hand-off [steering instructions]
```

## `/clear` behavior

When `/clear` runs, the extension:

1. waits for the agent to become idle if needed, notifying you that it's waiting
2. captures the active model and thinking level
3. starts a new session via `ctx.newSession()`
4. restores the captured model and thinking level in the new session
5. shows a warning if clearing is cancelled or the captured model can no longer be applied (e.g. its auth was removed)

Because the model is applied with `pi.setModel()`, it's recorded in the new session's transcript — so it also survives `/resume`.

## `/hand-off` behavior

When `/hand-off` runs, the extension:

1. waits for the agent to become idle if needed
2. opens a model picker, then a thinking level picker, then a steering editor pre-filled with any text you typed after `/hand-off`. Defaults are sensible: the current model and thinking level are preselected, so pressing Enter at each step keeps them. The model picker respects your session's model scoping (`--models` / `enabledModels`, the same set `/scoped-models` shows); without scoping it falls back to a two-level provider → model pick so the dialog never floods the screen
3. sends the current agent a message asking it to write its **next message as the hand-off prompt** — instructions to the next agent, with no preamble or postamble
4. captures that final assistant message, starts a new session, applies the model and thinking level you picked, and inserts the hand-off prompt into the editor via `ctx.ui.setEditorText()`
5. stops there: the prompt sits in the editor for you to review, edit, and submit yourself

Cancelling any dialog aborts the hand-off before anything is sent to the agent. If the agent doesn't produce a hand-off prompt, the extension stays in the current session and reports an error.

The `/hand-off` request is recorded in the current session's transcript, and the hand-off prompt becomes the first user message of the new session — so both sides of the hand are visible in their respective session histories.

## Notes

- `/clear` only registers the slash command; it does not bind a keyboard shortcut, so it won't conflict with other extensions (such as `pi-mono-clear`, which uses `Ctrl+Shift+L`).
- The model handoff is in-process only: it never touches the filesystem, is invisible to other pi processes, and is discarded if pi exits between clearing and restoring.
- Like `/new`, `/clear` does not carry over conversation history, compaction summaries, or session name.

## How it works

pi tears down the current runtime when a session is replaced, and extension instances are recreated for the new session. Session-bound objects can't be reused across that boundary, and the post-switch context has no model setter — but the replacement happens within the same process. So both commands capture state as plain data in a `globalThis` property, and the new session's extension instance consumes it on `session_start` (reason `new`) and applies it with `pi.setModel()` (plus `ctx.ui.setEditorText()` for the hand-off prompt). The handoff is consumed exactly once, so it can never leak into a later session.

`/hand-off` captures the agent's response by watching the `agent_end` event while the hand-off request is in flight, using per-instance state that dies with the session — only the final payload crosses into the new session via `globalThis`.

## Development

Load the extension directly for local testing:

```sh
pi -e ./index.ts
```

There are also RPC smoke tests that verify the behavior end-to-end by starting pi in RPC mode:

```sh
python3 scripts/rpc-smoke-test.py          # /clear keeps model + thinking level
python3 scripts/rpc-handoff-smoke-test.py  # /hand-off full flow, dialogs included
```

Both require at least two models with configured auth.

## Related extensions

- [`pi-mono-clear`](https://github.com/emanuelcasco/pi-mono-extensions) — a `/clear` alias for `/new` (does not preserve the model)

## License

[MIT](LICENSE)
