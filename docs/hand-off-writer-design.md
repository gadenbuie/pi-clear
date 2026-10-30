# Design: choosing who writes the `/hand-off` prompt

Status: design draft (pre-implementation)

## Goal

Today `/hand-off` always uses the live agent: `pi.sendMessage({triggerTurn: true})`
asks the current agent to write its next message as a hand-off prompt, and
`agent_end` captures it. That inherits the current session's **entire**
transcript, and its **whole** context window, and its **tool access**.

Add an alternative: a single out-of-band model call over a **minimal
reconstruction** of the conversation. Then:

- an old, long conversation can be handed off even when it no longer fits a
  model's context window;
- a cheap/fast model can do the summarizing while an expensive model does the
  work;
- handing off still works when the session's current model has lost auth or was
  removed from the catalogue.

Non-goals for v1: picking a *different session file* to hand off from (the
source is always the current session), multi-pass chunked summarization, and
tool access for the summarizer.

## Feasibility (verified against `@earendil-works/pi-coding-agent` 1.3.0 / 1.4.0)

| Need | API | Precedent |
|---|---|---|
| One-shot call to an arbitrary model, no session, no tools | `ctx.modelRegistry.complete(model, { systemPrompt, messages }, { signal, cacheRetention: "none", sessionId })` | `examples/extensions/handoff.ts`, `summarize.ts`, `custom-compaction.ts` |
| Read the conversation, post-compaction | `ctx.sessionManager.buildSessionProjection().messages` | `ReadonlySessionManager` pick list |
| Progress + cancel | `BorderedLoader` (exported) with `loader.signal` → `complete({ signal })` | `examples/extensions/handoff.ts` |
| Message-role handling | raw `AgentMessage` roles: `user`, `assistant`, `toolResult`, `custom`, `compactionSummary`, `branchSummary`, `bashExecution` | `dist/core/messages.js` |
| Token estimate for budgeting | `estimateTokens(message)` (optional) | exported from root |
| Model picker, thinking picker | existing `pickTargetModel()` / `selectThinkingLevel()` | this repo |
| Carry state across session replacement | existing `globalThis` handoff + `session_start` | this repo |

Nothing new is required from pi. `pi.setModel()` is still absent from
`ReplacedSessionContext`, so the `globalThis` mechanism stays.

## Flow

```
/hand-off [--fresh | --live] [steering…]
   │
   ├─ parse leading flags; everything else stays steering text
   │     --fresh → writer = fresh        --live → writer = live agent
   │     both given → notify and stop
   │
   ├─ wait for idle (unchanged)
   │
   ├─ [1] "Who writes the hand-off prompt?"     ← always asked unless a flag chose
   │        ▸ This agent — full context and tools        → live path, zero change
   │          Fresh pass — current model                 → [2b] skipped
   │          Fresh pass — another model…                → [2b]
   │        (with handoff.summarizerModel pinned, its label replaces the
   │         "current model" entry and [2b] is skipped)
   │
   ├─ [2b] summarizer model picker (reuses pickTargetModel, current preselected)
   │
   ├─ [2c] target model picker + thinking level (unchanged)
   │
   ├─ [2d] steering editor, pre-filled from the remaining command args (unchanged)
   │
   ├─ generation
   │     live path  : sendMessage + agent_end capture (unchanged)
   │     fresh path : BorderedLoader → modelRegistry.complete(minimal transcript)
   │                  non-TUI: notify("Writing hand-off prompt…") → complete()
   │
   ├─ validate: stopReason === "stop", non-empty text
   │
   └─ writeHandoff(...) → ctx.newSession() → session_start inserts prompt in editor
```

Cancel at any dialog or Esc on the loader → stay in the current session, nothing
sent, `flowInProgress` cleared.

**Naming.** The second path is a **"fresh pass"** (flag `--fresh`, UI label
"Fresh pass"); the existing path is the **live agent** (flag `--live`). There is
no configured default writer: which one to use depends on the conversation in
front of you, so the picker decides per run, and the flags exist only for people
who already know. The live agent stays first in the list so pressing Enter keeps
today's behavior.

## Minimal transcript

Built from `ctx.sessionManager.buildSessionProjection().messages` — the
post-compaction view, so an old session that was compacted summarizes from its
summary rather than from nothing.

Serialized as plain text blocks, newest-first accumulation (see Budget):

| AgentMessage role | Rendered as |
|---|---|
| `user` | `[User]: <text>` (head+tail truncated to 8,000 chars) |
| `assistant` | `[Assistant]: <text blocks only>` (head+tail truncated to 4,000 chars); thinking blocks dropped entirely |
| `assistant` tool calls | one `[tools]:` block, one hint per line (below) |
| `toolResult` | **dropped** |
| `custom` with `customType === "pi-clear:hand-off-request"` | dropped (stale hand-off requests) |
| any other `custom` | `[Note]: <text>` truncated |
| `compactionSummary`, `branchSummary` | `[Summary of earlier conversation]: <summary>` truncated |
| `bashExecution` | `[User ran]: <command>` — output dropped |

Tool-call hints (`name` + arguments only, no results, no diffs):

```
read   src/foo.test.ts          read  src/foo.test.ts
edit   src/foo.ts               edit  src/foo.ts
write  docs/notes.md            →  write docs/notes.md
bash   npm test -- foo.test.ts  →  bash: npm test -- foo.test.ts   (first line, ≤200 chars)
grep   pattern, path            →  grep: /fail.*assert/ in src/
find / ls with path/pattern     →  find: *.test.ts in src/
other tools                     →  tool: <name> <path-or-first-string-arg> (best effort)
```

Example output:

```
[User]: the foo suite fails after my refactor, fix it

[Assistant]: Looking at the suite and the module it covers.

[tools]:
read src/foo.test.ts
read src/foo.ts
bash: npm test -- foo.test.ts

[Assistant]: The refactor renamed `add` to `sum` but the test still calls `add`.

[tools]:
edit src/foo.ts
edit src/foo.test.ts
bash: npm test -- foo.test.ts

[Assistant]: Suite passes now.
```

Followed by a file-operations footer, computed the same way pi does for
compaction (`computeFileLists` semantics, reimplemented locally) so the next
agent knows what to open:

```
<read-files>
src/foo.test.ts
</read-files>

<modified-files>
src/foo.ts
</modified-files>
```

## Budget: keep head and tail

Unit of truncation is a rendered block, never a character offset inside a block
(so a hint line or a message never gets cut in half by the budget logic;
individual over-long messages are head+tail truncated first).

```
maxSourceChars   default 200_000  (~50k tokens)  configurable
tailBudget       = maxSourceChars * 0.6
headBudget       = maxSourceChars * 0.4

head = first user message block, always kept (hard-capped at 8,000 chars)
tail = blocks walked newest → oldest while cumulative chars ≤ tailBudget
gap  = older blocks between head and tail, walked oldest → newest until headBudget
       is exhausted, contiguous from just after head
elision marker between gap and tail:
    [... <n> turns omitted — <k> chars ...]
```

Rules:

- If everything fits, emit it verbatim with no marker.
- If the first user message alone exceeds the cap, truncate it head+tail and say so.
- Always report elision to the user before generating:
  `ctx.ui.notify("Hand-off source trimmed: 42 earlier turns omitted (~118k chars dropped)", "info")`
  so they can raise `maxSourceChars` or switch to the agent path.
- `maxSourceChars: 0` means "no budget" (escape hatch).

## Prompt for the fresh pass

System prompt (new constant, replaces nothing — the agent path keeps
`buildHandoffRequest`):

```
You are a context transfer assistant. You will receive a minimall reconstruction
of a long conversation between a user and an AI agent, and you must write the
hand-off message that starts the next session.

Do not continue the conversation. Do not answer questions in it.

The reconstruction is lossy: tool output, thinking, and file contents are
omitted, and a middle section may be elided. Do not assert file contents or the
state of the working tree from memory — when something cannot be verified from
the transcript, tell the next agent to verify it.
```

User message:

```
## Conversation (minimal reconstruction)
<serialized transcript + file lists>

## What the hand-off must cover
<steering text, or the default requirements>

Requirements for your output:
- Written as instructions to the next agent ("you"), not a report about the past.
- Assume zero prior context: current task and goal, what was done so far with
  concrete file paths, commands, and decisions, and exactly what to do next.
- Name the files worth opening first.
- Reply with ONLY the hand-off message: no preamble, no postamble, no fences.
```

Call options: `{ signal, cacheRetention: "none", sessionId: uuid }`, plus
`reasoning` when the writer model supports it and a level was chosen (see
Open questions [2]).

Validation mirrors pi's `getSummarizationFailure`: reject
`stopReason !== "stop"` (notably `"length"`), strip surrounding fences, reject
empty.

## Session provenance note (both paths)

Every hand-off prompt gets a short provenance comment prepended, naming the
session it came from, so the next agent can look the original session up when
the hand-off is not enough. It is added by the extension **after** the prompt is
captured or generated — never asked of the summarizing model, so it cannot be
reworded away, and both paths get it identically.

```markdown
<!-- Handed off from pi session 01a18da2-4eff-73b9-846d-5fd4c156e52e -->
```

Details:

- A comment, not prose, so it does not read as part of the task. It stays
  visible in the editor (plain text), invisible in rendered markdown.
- Just the session id: nothing assumes another tool (pirecall, the transcript
  path, the session name) is available or still meaningful.
- `ctx.sessionManager.getSessionId()` is the only source; when there is no id,
  no comment is emitted at all.
- Composed by one helper, `withSessionProvenance(prompt, ctx)`, called once in
  the `/hand-off` handler right before `writeHandoff()`, so `/clear` (which
  shares the handoff struct) is untouched.

## Configuration

Settings live in `<agent-dir>/pi-clear.json` (`<agent-dir>` defaults to
`~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR`). Read once per
`session_start`; a malformed file is reported as a warning and ignored.

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

- No `writer` default. The [1] picker decides every run (see Naming above).
- `summarizerModel`: `"provider/model-id"`, preselected in [2b] and used as the
  "Fresh pass — <model>" entry in [1].
- `askSummarizerModel`: `false` **and** `summarizerModel` set ⇒ [2b] is skipped
  entirely (this is the "skip the extra choice" case).
- `summarizerThinkingLevel`: preselected in the writer's thinking-level picker;
  `"default"` (or `"off"`) means the provider default.
- `maxSourceChars`: transcript budget, `0` disables.

Two separate override surfaces, easy to confuse:

- **Command args** (parsed inside the `/hand-off` handler, per invocation):
  `/hand-off --fresh`, `/hand-off --live`, and the steering text that remains
  after the leading flags. There is deliberately no `--summarizer` flag: nobody
  hand-writes model IDs, so a writer-model preference belongs in the config
  file and otherwise the picker just opens.
- **pi CLI flags** (registered with `pi.registerFlag()`, per pi launch, for
  people who always want the same thing): `--hand-off-max-source-chars=<n>` and
  optionally `--hand-off-summarizer=<provider/model>`.

Precedence: pi CLI flag > config file > built-in default.

Later choice memory (nice to have, not v1): `pi.appendEntry("pi-clear:last-handoff", …)`
to preselect the last used summarizer model within a session.

## Failure modes

| Situation | Behavior |
|---|---|
| `--fresh` and `--live` both given | notify the conflict, stop before any dialog |
| Empty conversation | notify "No conversation to hand off", stay |
| `flowInProgress` | refuse (unchanged) |
| Agent busy | `waitForIdle` with notify (unchanged) |
| Summarizer model has no auth | filtered out of the picker; `complete()` failure → notify, stay in session |
| Summarizer returns abort | treat as cancel, stay |
| Summarizer returns `length`/error | notify with reason, stay in session (same rule the agent path applies to non-`stop`) |
| Esc on loader | abort the request via `loader.signal`, stay |
| Non-TUI mode | no `BorderedLoader`: `notify` + plain `complete()`, no cancel |
| Old session's model gone | agent path blocks, fresh path unaffected — this is the case the feature exists for |

## Test plan

- `scripts/rpc-handoff-smoke-test.py` **must be updated**: the dialog sequence
  gains an initial writer picker, and the fresh path has no `agent_end` turn.
  Add a second scripted scenario (`/hand-off --fresh`) asserting that no agent
  turn starts and that a model call happens over the minimal transcript.
- New unit-ish script `scripts/minimal-transcript.test.mjs` (no pi process) for
  the serializer + budget: thinking dropped, tool results dropped, hints
  formatted, elision marker + head/tail retention, file-op footer.
  `scripts/model-picker.test.mjs` shows the existing no-pi test pattern.
- The RPC smoke test asserts the provenance comment is present and carries the
  old session id, for both the live path and the `--fresh` path.
- `tsc --noEmit` (no config in repo; needs `--module nodenext --moduleResolution nodenext --target es2022 --strict`, matching the existing file's style).
- Live smoke tests need explicit user confirmation (AGENTS.md).

## Docs and release

- README: new `/hand-off` step 0, a "choosing the writer" section, config file,
  the provenance comment, and a note that the fresh pass has no tool access.
- CHANGELOG: Unreleased → Added; minor bump to `0.4.0` (new feature, default
  behavior unchanged apart from the provenance comment, which is additive).

## Open questions

1. **Flag name for the live agent path.** `--live` is the current placeholder,
   chosen to pair with `--fresh`. Alternatives: `--in-session`, `--inline`,
   `--current`, `--agent` (rejected as the least descriptive of the set).
2. ~~Should the fresh pass be allowed to run with a different thinking level?~~
   **Resolved: yes.** The fresh pass asks for the writer's thinking level with
   the provider default preselected (`handoff.summarizerThinkingLevel` sets a
   standing preference). The level is passed as the `reasoning` option and only
   when the model declares reasoning support, the way pi's own summarization
   does. Models without reasoning controls skip the dialog.
3. When `--fresh` is passed explicitly and no summarizer model is pinned, does
   [2b] still open (default yes, since the model choice matters more than the
   keystroke), or should `--fresh` imply "current model, don't ask"?
