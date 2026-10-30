# pi-clear

A [pi](https://github.com/earendil-works/pi) extension with two commands:

- `/clear` — start a fresh session **without losing your model**
- `/hand-off` — hand the conversation to another model with a prompt written by the current agent, or by a cheap one-off "fresh pass"

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
/hand-off [--fresh | --live] [--summarizer=provider/model] [steering instructions]
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

0. **chooses who writes the hand-off prompt** — see [Choosing the writer](#choosing-the-writer). The picker is skipped when `--fresh` or `--live` was passed
1. waits for the agent to become idle if needed
2. opens a model picker, then a thinking level picker, then a steering editor pre-filled with any text you typed after `/hand-off` (and its flags). Defaults are sensible: the current model and thinking level are preselected, so pressing Enter at each step keeps them. The model picker respects your session's model scoping (`--models` / `enabledModels`, the same set `/scoped-models` shows) and offers a Tab toggle between scoped and all models. In non-TUI modes it falls back to plain dialogs: the scoped list when configured, otherwise a two-level provider → model pick so the dialog never floods the screen
3. writes the hand-off prompt with the chosen writer — the live agent, or a single off-screen model call over a minimal reconstruction of the conversation
4. prepends a provenance comment naming the source session, starts a new session, applies the model and thinking level you picked, and inserts the prompt into the editor via `ctx.ui.setEditorText()`
5. stops there: the prompt sits in the editor for you to review, edit, and submit yourself

Cancelling any dialog aborts the hand-off before anything is sent. If the writer doesn't produce a prompt, the extension stays in the current session and reports why.

On the live-agent path the request itself is recorded in the current session's transcript; either way, the hand-off prompt sits in the new session's editor — it becomes the first user message once you review and submit it.

Two limitations worth knowing: on the live-agent path, if you queue another message while the agent is writing the hand-off prompt, the capture may pick up the wrong response — avoid queueing during generation. And `/clear` and `/hand-off` guard against running at the same time.

### Choosing the writer

There is deliberately no configured default: which writer to use depends on the conversation in front of you, so `/hand-off` asks every time.

| Writer | How it writes the prompt |
|---|---|
| **This agent — full context and tools** (first, so Enter keeps the old behavior) | The current agent writes its next message as the hand-off prompt. It sees the whole transcript and keeps its tools. |
| **Fresh pass — current model** | One out-of-band `modelRegistry.complete()` call over a *minimal reconstruction* of the conversation: your messages, the assistant's visible text, and one-line hints for tool calls. No tool output, no thinking, and a head+tail character budget. **No tool access.** |
| **Fresh pass — another model…** | Same, but you pick the model that writes the prompt first (a cheap, fast model is a good choice). |

The fresh pass exists because the live agent's prompt inherits the session's whole context window: an old or long conversation may no longer fit, and a session whose model lost auth can still be handed off. Because it never reads tool output, it is told to have the next agent verify anything it cannot see in the transcript.

Fresh pass flags and limits:

- `--fresh` skips the writer picker and uses the fresh pass; `--live` skips it and uses the current agent. Passing both is refused before any dialog opens.
- `--summarizer=provider/model` pins the model that writes the prompt (skips that picker too).
- The source is the post-compaction view of the session, so a compacted conversation is summarized from its summary rather than from nothing.
- Trimming keeps the opening message, the newest turns, and a contiguous run after the opening message; the middle is replaced by `[... <n> turns omitted — <k> chars ...]` and you get a notification saying how much was dropped. Raise the budget with the settings below if that happens.

### Session provenance

Every hand-off prompt (from either writer) starts with a comment naming the session it came from:

```markdown
<!-- Handed off from pi session 01a18da2-4eff-73b9-846d-5fd4c156e52e -->
```

It's a comment, so it doesn't read as part of the task and stays visible in the editor for you to check. The extension adds it after the prompt is written, so the writing model can't reword or drop it.

## Configuration

Optional settings live in `<agent-dir>/pi-clear.json` (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`), read once per session:

```json
{
  "handoff": {
    "summarizerModel": "anthropic/claude-haiku-4-5",
    "askSummarizerModel": true,
    "maxSourceChars": 200000
  }
}
```

- `summarizerModel` — preselected in the writer-model picker, and offered as its own `Fresh pass — <model>` entry in the writer picker.
- `askSummarizerModel: false` — with `summarizerModel` set, skip the writer-model picker entirely and always use that model.
- `maxSourceChars` — characters of conversation sent to the fresh pass (default `200000`, about 50k tokens). `0` disables the budget.

A malformed file is reported as a warning and ignored. The same knobs are available per pi launch as CLI flags, and per run as command args:

```sh
pi --hand-off-summarizer=anthropic/claude-haiku-4-5 --hand-off-max-source-chars=400000
```

Precedence: command arg > pi CLI flag > config file > built-in default.

## Notes

- `/clear` only registers the slash command; it does not bind a keyboard shortcut, so it won't conflict with other extensions (such as `pi-mono-clear`, which uses `Ctrl+Shift+L`).
- The model handoff is in-process only: it never touches the filesystem, is invisible to other pi processes, and is discarded if pi exits between clearing and restoring.
- Like `/new`, `/clear` does not carry over conversation history, compaction summaries, or session name.

## How it works

pi tears down the current runtime when a session is replaced, and extension instances are recreated for the new session. Session-bound objects can't be reused across that boundary, and the post-switch context has no model setter — but the replacement happens within the same process. So both commands capture state as plain data in a `globalThis` property, and the new session's extension instance consumes it on `session_start` (reason `new`) and applies it with `pi.setModel()` (plus `ctx.ui.setEditorText()` for the hand-off prompt). The handoff is consumed exactly once, so it can never leak into a later session.

`/hand-off` captures the live agent's response by watching the `agent_end` event while the hand-off request is in flight, using per-instance state that dies with the session — only the final payload crosses into the new session via `globalThis`.

The fresh pass never sends a message to the agent at all: it calls `ctx.modelRegistry.complete()` once with a system prompt and a single user message built from `buildSessionProjection().messages`, runs the reply through the same validation as the live path (`stopReason === "stop"`, non-empty, surrounding fences stripped), and carries the result across the same `globalThis` handoff.

## Development

Load the extension directly for local testing:

```sh
pi -e ./index.ts
```

There are also smoke tests that verify the behavior end-to-end by starting pi in RPC mode:

```sh
python3 scripts/rpc-smoke-test.py          # /clear keeps model + thinking level
python3 scripts/rpc-handoff-smoke-test.py  # /hand-off, both writers, dialogs included
node --test scripts/model-picker.test.mjs          # offline: model picker behavior
node --test scripts/minimal-transcript.test.mjs    # offline: fresh-pass transcript + budget
```

The RPC smoke tests require at least two models with configured auth, and they make **real, billed model requests**. The `node --test` scripts need neither.

## Related extensions

- [`pi-mono-clear`](https://github.com/emanuelcasco/pi-mono-extensions) — a `/clear` alias for `/new` (does not preserve the model)

## License

[MIT](LICENSE)
