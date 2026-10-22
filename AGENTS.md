# pi-clear agent instructions

pi-clear is a pi extension providing `/clear` (fresh session, keeps model) and
`/hand-off` (hand the conversation to another model). Single-file extension in
`index.ts`; docs in `README.md`.

## Running tests requires confirmation

The smoke tests in `scripts/` run a real pi process against the user's
configured models and auth:

- `scripts/rpc-smoke-test.py` — makes **no model requests** (only local RPC
  state changes), but still launches pi with the user's live configuration.
- `scripts/rpc-handoff-smoke-test.py` — makes a **real LLM request** billed to
  the user's account (the agent generates the hand-off prompt).

Before running either script, tell the user what it does and **ask for
confirmation first**. Do not run them as a side effect of other work, in
loops, or in parallel with each other. Typechecking (`tsc --noEmit`) needs no
confirmation.

## Conventions

- `index.ts` is the entire extension; keep the header doc comment in sync
  with behavior.
- Changelog follows Keep a Changelog; the version in `package.json` and the
  changelog section should match before tagging.
- The `v0.3.0` tag has been force-moved before (it was never published to
  npm); when releasing, confirm the tag points at the intended commit.
