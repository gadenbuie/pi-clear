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
/hand-off [--fresh | --live] [--same] [steering instructions]
/hand-off-chain <N | off | status> [--max-cost USD] [task]
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
2. asks whether the next session keeps the current model and thinking level — the first option, so pressing Enter keeps them — or opens a model picker, then a thinking level picker, then collects steering instructions: text you typed after `/hand-off` (and its flags) is used as-is, and the steering editor only opens when you passed none. `--same` skips the same-or-pick dialog and re-uses the current model and thinking level. The model picker respects your session's model scoping (`--models` / `enabledModels`, the same set `/scoped-models` shows) and offers a Tab toggle between scoped and all models. In non-TUI modes it falls back to plain dialogs: the scoped list when configured, otherwise a two-level provider → model pick so the dialog never floods the screen
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

When the writer model supports reasoning, the fresh pass also asks for its **thinking level**, with **provider default** preselected — so pressing Enter passes straight through. Set a standing preference with `handoff.summarizerThinkingLevel` in the config file; the picker then preselects that level instead, and the level is passed to the model as `reasoning`. Models without reasoning controls skip the dialog entirely.

Fresh pass flags and limits:

- `--fresh` skips the writer picker and uses the fresh pass; `--live` skips it and uses the current agent. Passing both is refused before any dialog opens.
- `--same` skips the same-or-pick dialog and re-uses the current session's model and thinking level. It combines freely with `--fresh` / `--live` and inline steering.
- Flags are only recognized at the front of the command args: `/hand-off --same fix the tests` parses the flag, but `/hand-off fix the tests --same` passes `--same` through as steering text. Anything after the first non-flag token is steering.
- There is no command-arg model flag: if you want a specific model to write the prompt, set it in the [config file](#configuration) (or pick it from the menu).
- The source is the post-compaction view of the session, so a compacted conversation is summarized from its summary rather than from nothing.
- Trimming keeps the opening message, the newest turns, and a contiguous run after the opening message; the middle is replaced by `[... <n> turns omitted — <k> chars ...]` and you get a notification saying how much was dropped. Raise the budget with the settings below if that happens.

### Session provenance

Every hand-off prompt (from either writer) starts with a comment naming the session it came from:

```markdown
<!-- Handed off from pi session 01a18da2-4eff-73b9-846d-5fd4c156e52e -->
```

It's a comment, so it doesn't read as part of the task and stays visible in the editor for you to check. The extension adds it after the prompt is written, so the writing model can't reword or drop it.

## Autonomous chains

Long plans outgrow one context window. `/hand-off-chain` lets a run keep going without you: when an agent finishes its part, it hands off to a fresh agent, which picks up where it left off, until the work is done, something goes wrong, or a limit you set is reached.

It's off unless you run it. Use `/hand-off` when you want to review each hand-off yourself.

### Quick start

```text
/hand-off-chain 8 --max-cost 5 Do the next unchecked item in PLAN.md, run the tests, tick it off, and commit.
```

That arms a chain of up to 8 hand-offs, with a $5 limit. The agent you're talking to is step 0 and isn't counted, so the chain can run up to 9 agents. Your task goes to the current agent. Each new agent starts fresh and sees only the previous agent's hand-off plus whatever is on disk, so the task should say where progress is tracked, such as a plan file with checkboxes or the git log.

If you leave the task out, the chain is armed and waits; type your task as your next message.

Every agent runs with your full tool access and nobody watches live, so run chains in a repo you can recover, and set `--max-cost`. Every session uses the model and thinking level you started with.

### How an agent ends

Each agent is told how to finish. Its entire final message is one of:

- `<hand-off>…</hand-off>`: what it did, what's next, and any gotchas. The next session starts from this.
- `<hand-off done/>`: the work is complete.
- `<hand-off pause>question</hand-off>`: it needs an answer from you. The chain waits in that session; reply there and it carries on when the agent finishes.
- `<hand-off stop>reason</hand-off>`: it can't continue (blocked, tests failing). The chain ends and you see the reason.

If an agent forgets the tag, it gets one reminder before the chain gives up.

### Cost limit

`--max-cost` takes dollars and goes before your task. As spending nears the limit, the agent is nudged to wrap up:

| Spent | What the agent is told |
| --- | --- |
| 80% | Heads-up: plan to wrap up soon. |
| 95% | Stop now: finish only the final tasks and leave things consistent. |
| 98% | Out of budget: write a final status summary. |
| 100% | The session is aborted and the chain stops. |

Past 95%, the chain won't start a new session. Costs are only known after each model call, so one expensive turn can overshoot, and models that don't report cost can't be limited this way. Without `--max-cost` there is no limit.

### When it stops

You get a notification with the reason and the total spent. A chain stops when:

- an agent signals `done` or `stop` (a `pause` waits for you instead);
- the last allowed agent asks for another hand-off;
- the cost limit is hit;
- you abort a run, or an agent fails to finish cleanly;
- an agent ignores the reminder to end with a tag.

### Checking on it

- `/hand-off-chain status` shows the current step, spend so far, and the sessions in the chain.
- `/hand-off-chain off` disarms it.

Each session the chain leaves records its model, tokens, and cost, and a chain that stops records why in the session it stopped in, and every session after the first begins with a comment naming the step and the session it came from. You can resume any of them with `/resume`.

A chain lives in the running pi process, so quitting pi ends it, and each process can run one chain at a time. Starting a new session yourself doesn't disturb it.

## Configuration

Optional settings live in `<agent-dir>/pi-clear.json` (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`), read once per session:

```json
{
  "handoff": {
    "summarizerModel": "anthropic/claude-haiku-4-5",
    "askSummarizerModel": true,
    "summarizerThinkingLevel": "low",
    "maxSourceChars": 200000
  }
}
```

- `summarizerModel` — preselected in the writer-model picker, and offered as its own `Fresh pass — <model>` entry in the writer picker.
- `askSummarizerModel: false` — with `summarizerModel` set, skip the writer-model picker entirely and always use that model.
- `summarizerThinkingLevel` — preselected in the writer's thinking-level picker: `"default"` (or `"off"`) for the provider default, otherwise `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The dialog stays available either way.
- `maxSourceChars` — characters of conversation sent to the fresh pass (default `200000`, about 50k tokens). `0` disables the budget.

A malformed file is reported as a warning and ignored. The same knobs are available per pi launch as CLI flags:

```sh
pi --hand-off-summarizer=anthropic/claude-haiku-4-5 --hand-off-max-source-chars=400000
```

Precedence: pi CLI flag > config file > built-in default. On the command line, only the writer choice (`--fresh` / `--live`) is available — a model ID belongs in the config file or the picker.

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
node --test scripts/fresh-pass-flow.test.mjs       # offline: /hand-off flow, both writers
```

The RPC smoke tests need at least two models with configured auth.
`rpc-handoff-smoke-test.py` makes **real, billed model requests** (the agent
writes the hand-off prompt); `rpc-smoke-test.py` only drives local RPC state
and makes none. The `node --test` scripts need neither auth nor a pi process.

## Related extensions

- [`pi-mono-clear`](https://github.com/emanuelcasco/pi-mono-extensions) — a `/clear` alias for `/new` (does not preserve the model)

## License

[MIT](LICENSE)
