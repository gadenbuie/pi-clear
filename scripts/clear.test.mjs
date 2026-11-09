// Offline test for /clear with mocked pi APIs.
// Run with Node 24+: node --test scripts/clear.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { MOVED_NOTICE, takeMovedNotice } from "../index.ts";

function setup({ modelFound = true, applied = true } = {}) {
	const commands = new Map();
	const handlers = new Map();
	const calls = { setModel: [], setThinkingLevel: [], notify: [] };
	const model = { provider: "p", id: "m" };
	const pi = {
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, fn) => handlers.set(event, fn),
		setModel: async (m) => (calls.setModel.push(m), applied),
		setThinkingLevel: async (l) => void calls.setThinkingLevel.push(l),
		getCommands: () => [],
	};
	extension(pi);
	const replacementCtx = {
		modelRegistry: { find: () => (modelFound ? model : undefined) },
		ui: { notify: (message, type) => calls.notify.push({ message, type }) },
	};
	const ctx = {
		model,
		thinkingLevel: "high",
		isIdle: () => true,
		waitForIdle: async () => {},
		ui: replacementCtx.ui,
		newSession: async () => {
			await handlers.get("session_start")({ reason: "new" }, replacementCtx);
			return { cancelled: false };
		},
	};
	return { commands, handlers, calls, ctx, model, replacementCtx };
}

test("/clear restores the model and thinking level in the new session", async () => {
	const { commands, calls, ctx, model } = setup();
	await commands.get("clear").handler("", ctx);
	assert.deepEqual(calls.setModel, [model]);
	assert.deepEqual(calls.setThinkingLevel, ["high"]);
	assert.deepEqual(calls.notify, []);
});

test("/clear warns when the model is gone or has no auth", async () => {
	let t = setup({ modelFound: false });
	await t.commands.get("clear").handler("", t.ctx);
	assert.match(t.calls.notify[0].message, /no longer available/);
	assert.deepEqual(t.calls.setModel, []);

	t = setup({ applied: false });
	await t.commands.get("clear").handler("", t.ctx);
	assert.match(t.calls.notify[0].message, /no auth/);
	assert.deepEqual(t.calls.setThinkingLevel, []);
});

test("a later /new does not inherit a stale handoff", async () => {
	const { commands, handlers, calls, ctx, replacementCtx } = setup();
	ctx.newSession = async () => ({ cancelled: true });
	await commands.get("clear").handler("", ctx);
	assert.match(calls.notify[0].message, /cancelled/);
	await handlers.get("session_start")({ reason: "new" }, replacementCtx);
	assert.deepEqual(calls.setModel, []);
});

test("the moved notice is shown once per agent dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-clear-notice-"));
	assert.equal(takeMovedNotice(dir), true);
	assert.equal(takeMovedNotice(dir), false);
	assert.match(MOVED_NOTICE, /pi-hand-off/);
});
