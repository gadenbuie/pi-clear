# pi-clear

A [pi](https://github.com/earendil-works/pi) extension that adds `/clear`: start a fresh session **without losing your model or thinking level**.

Previously used `/hand-off`? It has [moved to pi-hand-off](#moving-to-pi-hand-off).

## Why?

Unlike pi's built-in `/new`, `/clear` keeps the model and thinking level you chose in the current session when you start a fresh one.

## Install

```sh
pi install npm:@grrrck/pi-clear
```

Or try it without installing:

```sh
pi -e npm:@grrrck/pi-clear
```

To install straight from GitHub instead of npm (the latest `main`, or pin a tag or commit after `@`):

```sh
pi install git:github.com/gadenbuie/pi-clear
pi install git:github.com/gadenbuie/pi-clear@main
```

## Usage

```text
/clear
```

If the agent is busy, `/clear` lets you know and waits for it to finish. It then starts a fresh session with your current model and thinking level. If the model can no longer be restored (for example, its auth was removed), you'll see a warning. When the new session is saved, the restored model and thinking level also survive `/resume`.

## Notes

- `/clear` creates no separate handoff file or persisted state of its own; it simply starts a new conversation.
- Like `/new`, `/clear` does not carry over conversation history, compaction summaries, or session name. It doesn't delete the prior conversation; previously saved sessions remain available via `/resume`.

## Moving to pi-hand-off

Versions up to 0.5.0 also shipped `/hand-off`. To keep using it, install [`@grrrck/pi-hand-off`](https://github.com/gadenbuie/pi-hand-off):

```sh
pi install npm:@grrrck/pi-hand-off
```

Optional notes:

- You can remove `@grrrck/pi-clear` if you no longer want `/clear`; the two packages can be installed side by side.
- If you type `/hand-off` while no `/hand-off` command is installed, `pi-clear` shows a notice pointing to the new package instead of sending the text to the model.
- `pi-hand-off` still reads settings from `<agent-dir>/pi-clear.json` when `pi-hand-off.json` doesn't exist. You can rename the file. The agent directory defaults to `~/.pi/agent` and can be changed with `PI_CODING_AGENT_DIR`.

## How it works

The model and thinking level handoff is temporary and in-process. The new session consumes it exactly once; if pi exits first, it is discarded.

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
