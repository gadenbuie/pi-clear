// Offline flow tests for the /hand-off fresh pass: mocked ExtensionAPI and
// context only — no pi process, no user configuration, no model requests.
// Run with Node 24+: node --test scripts/fresh-pass-flow.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../index.ts";

// Keep loadHandoffSettings() away from the real ~/.pi/agent.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-clear-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const current = { provider: "anthropic", id: "claude-opus-4-5", name: "Opus", reasoning: true };
const haiku = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku", reasoning: true };
const chatty = { provider: "local", id: "llama-plain", name: "Llama (no reasoning)", reasoning: false };
const other = { provider: "openai", id: "gpt-5.2", name: "GPT", reasoning: true };
const catalogue = [current, haiku, chatty, other];

const SESSION_ID = "01a18da2-4eff-73b9-846d-5fd4c156e52e";

const messages = [
	{ role: "user", content: [{ type: "text", text: "the suite fails, fix it" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "THINKING-MUST-NOT-APPEAR" },
			{ type: "text", text: "Reading the test." },
			{ type: "toolCall", name: "read", arguments: { path: "src/foo.test.ts" } },
			{ type: "toolCall", name: "edit", arguments: { path: "src/foo.ts" } },
		],
	},
	{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "TOOL-OUTPUT-MUST-NOT-APPEAR" }] },
	{ role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
];

/** Answer every dialog with the first entry unless `pick` says otherwise. */
function preferences(pick = () => undefined) {
	return pick;
}

/**
 * Run `/hand-off` against mocks and return everything observable.
 *
 * `pick(title, options)` chooses a dialog answer by default; `reply` replaces
 * the writer model's response.
 */
async function runHandoff({
	args = "--fresh",
	pick = preferences(),
	reply,
	flagMaxChars,
	model = current,
	conversation = messages,
} = {}) {
	const notifications = [];
	const dialogs = [];
	const requests = [];
	const applied = {};
	let editorText;
	let sendMessageCalls = 0;
	const commands = new Map();
	const handlers = new Map();

	const pi = {
		registerCommand: (name, command) => commands.set(name, command),
		registerFlag: () => {},
		getFlag: (name) => (name === "hand-off-max-source-chars" ? flagMaxChars : undefined),
		on: (event, handler) => handlers.set(event, handler),
		sendMessage: () => {
			sendMessageCalls++;
		},
		setModel: async (chosen) => {
			applied.model = chosen;
			return true;
		},
		setThinkingLevel: async (level) => {
			applied.level = level;
		},
		getSessionName: () => "flow test",
	};

	const modelRegistry = {
		getAvailable: () => catalogue,
		hasConfiguredAuth: () => true,
		find: (provider, id) => catalogue.find((entry) => entry.provider === provider && entry.id === id),
		complete: async (chosen, context, options) => {
			requests.push({ model: chosen, systemPrompt: context.systemPrompt, message: context.messages[0], options });
			return reply ?? { stopReason: "stop", content: [{ type: "text", text: "```\n# Hand-off\n\nStart here.\n```" }] };
		},
	};

	const replacementCtx = {
		ui: {
			setEditorText: (value) => {
				editorText = value;
			},
			notify: (message) => notifications.push({ message }),
		},
		modelRegistry,
	};

	extension(pi);

	const ctx = {
		mode: "rpc",
		hasUI: true,
		isIdle: () => true,
		waitForIdle: async () => {},
		model,
		thinkingLevel: "medium",
		scopedModels: [],
		modelRegistry,
		sessionManager: {
			buildSessionProjection: () => ({ messages: conversation }),
			getSessionId: () => SESSION_ID,
			getHeader: () => ({ timestamp: "2026-10-30T16:26:26.943Z" }),
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
			select: async (title, options) => {
				const chosen = pick(title, options) ?? options[0];
				dialogs.push({ title, options, chosen });
				return chosen;
			},
			editor: async (title, prefill) => {
				dialogs.push({ title, prefill });
				return prefill;
			},
			custom: () => {
				throw new Error("non-TUI mode must not open a custom component");
			},
		},
		// pi fires session_start (reason "new") inside newSession.
		newSession: async () => {
			await handlers.get("session_start")({ reason: "new" }, replacementCtx);
			return { cancelled: false };
		},
	};

	// pi fires session_start at startup (where the config file is read), then
	// again inside newSession for the replacement session.
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await commands.get("hand-off").handler(args, ctx);
	return { notifications, dialogs, requests, applied, editorText, sendMessageCalls };
}

const textOf = (request) => request.message.content[0].text;
const pickByTitle = (matches) => (title, options) => options.find((option) => matches(option));

test("--fresh skips the writer picker, writes with one call, and never touches the agent", async () => {
	const result = await runHandoff({ args: "--fresh mention the dry run" });

	assert.equal(result.sendMessageCalls, 0, "the fresh pass never sends messages to the agent");
	assert.equal(result.requests.length, 1, "exactly one model call");
	assert.ok(
		!result.dialogs.some((dialog) => /who writes/i.test(dialog.title)),
		"--fresh skips the writer picker",
	);
	assert.deepEqual(
		result.dialogs.map((dialog) => dialog.title),
		[
			"Hand-off writer provider",
			"Hand-off writer model",
			"Thinking level for the hand-off writer",
			"Hand off to provider",
			"Hand off to model",
			"Thinking level",
			"Steering for the hand-off prompt (sent to the hand-off writer)",
		],
	);
});

test("the request carries the minimal transcript and the steering text", async () => {
	const result = await runHandoff({ args: "--fresh mention the dry run" });
	const text = textOf(result.requests[0]);

	assert.ok(!text.includes("THINKING-MUST-NOT-APPEAR"), "thinking dropped");
	assert.ok(!text.includes("TOOL-OUTPUT-MUST-NOT-APPEAR"), "tool results dropped");
	assert.match(text, /\[tools\]:\nread src\/foo\.test\.ts\nedit src\/foo\.ts/);
	assert.match(text, /<read-files>\nsrc\/foo\.test\.ts\n<\/read-files>/);
	assert.match(text, /<modified-files>\nsrc\/foo\.ts\n<\/modified-files>/);
	assert.match(text, /## What the hand-off must cover\nmention the dry run/);
	assert.match(result.requests[0].systemPrompt, /context transfer assistant/);
	assert.equal(result.requests[0].options.cacheRetention, "none");
	assert.match(result.requests[0].options.sessionId, /^[0-9a-f-]{36}$/);
});

test("the editor gets the provenance comment and the stripped prompt", async () => {
	const result = await runHandoff();
	assert.match(result.editorText, new RegExp(`^<!-- Handed off from pi session ${SESSION_ID} -->\n\n`));
	assert.match(result.editorText, /^<!--[^]*-->\n\n# Hand-off\n\nStart here\.$/);
	assert.deepEqual(result.applied.model, current, "the destination model chosen in the dialog is applied");
});

test("the writer reasoning picker defaults to the provider default", async () => {
	const result = await runHandoff();
	const reasoning = result.dialogs.find((dialog) => dialog.title === "Thinking level for the hand-off writer");

	assert.ok(reasoning, "the reasoning picker opens for a reasoning-capable model");
	assert.equal(reasoning.options[0], "provider default  (current)");
	assert.deepEqual(reasoning.options.slice(1), ["minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(result.requests[0].options.reasoning, undefined, "no reasoning option is sent by default");
});

test("a chosen writer reasoning level is sent to the model", async () => {
	const result = await runHandoff({ pick: pickByTitle((option) => option.startsWith("xhigh")) });
	assert.equal(result.requests[0].options.reasoning, "xhigh");
});

test("a model without reasoning controls skips the writer reasoning picker", async () => {
	const result = await runHandoff({
		model: chatty,
		pick: pickByTitle((option) => option.includes("local/llama-plain")),
	});
	assert.ok(
		!result.dialogs.some((dialog) => dialog.title === "Thinking level for the hand-off writer"),
		"no reasoning picker for a non-reasoning model",
	);
	assert.equal(result.requests[0].options.reasoning, undefined);
	assert.deepEqual(result.requests[0].model, chatty);
});

test("a reasoning level from the config file is preselected and sent", async () => {
	writeFileSync(
		join(AGENT_DIR, "pi-clear.json"),
		JSON.stringify({ handoff: { summarizerThinkingLevel: "high" } }),
	);
	try {
		const result = await runHandoff();
		const reasoning = result.dialogs.find((dialog) => dialog.title === "Thinking level for the hand-off writer");
		assert.equal(reasoning.options[0], "high  (current)", "the configured level comes first");
		assert.ok(reasoning.options.includes("provider default"), "the default stays available");
		assert.equal(result.requests[0].options.reasoning, "high");
	} finally {
		writeFileSync(join(AGENT_DIR, "pi-clear.json"), "{}");
	}
});

test("a configured writer model skips the writer model picker but keeps the reasoning picker", async () => {
	writeFileSync(
		join(AGENT_DIR, "pi-clear.json"),
		JSON.stringify({ handoff: { summarizerModel: "anthropic/claude-haiku-4-5", askSummarizerModel: false } }),
	);
	try {
		const result = await runHandoff({
			pick: (title, options) => options.find((option) => option.startsWith("Fresh pass — another model")) ?? options[0],
		});
		assert.ok(
			!result.dialogs.some((dialog) => dialog.title === "Hand-off writer model"),
			"a pinned model is not asked about",
		);
		assert.ok(result.dialogs.some((dialog) => dialog.title === "Thinking level for the hand-off writer"));
		assert.deepEqual(result.requests[0].model, haiku);
	} finally {
		writeFileSync(join(AGENT_DIR, "pi-clear.json"), "{}");
	}
});

test("trimming notifies how much was dropped", async () => {
	const result = await runHandoff({ flagMaxChars: "40" });
	const notice = result.notifications.find((entry) => entry.message.startsWith("Hand-off source trimmed"));

	assert.ok(notice, JSON.stringify(result.notifications));
	assert.match(notice.message, /turns omitted \(~\d+[kM]? chars dropped\)/);
	assert.match(textOf(result.requests[0]), /\[\.\.\. \d+ turns omitted — \d+ chars \.\.\.\]/);
});

test("a non-stop reply stays in the current session", async () => {
	const result = await runHandoff({ reply: { stopReason: "length", content: [] } });

	assert.equal(result.editorText, undefined, "nothing carried across");
	assert.deepEqual(result.applied, {}, "no session swap");
	assert.ok(
		result.notifications.some((entry) => entry.type === "error" && /stopped with reason "length"/.test(entry.message)),
		JSON.stringify(result.notifications),
	);
});

test("--fresh --live is refused before any dialog", async () => {
	const result = await runHandoff({ args: "--fresh --live" });
	assert.deepEqual(result.dialogs, []);
	assert.equal(result.requests.length, 0);
	assert.ok(result.notifications.some((entry) => /cannot be combined/.test(entry.message)));
});

test("--live keeps the old path: the agent writes the prompt", async () => {
	const result = await runHandoff({ args: "--live" });
	assert.equal(result.requests.length, 0, "no out-of-band call on the live path");
	assert.equal(result.sendMessageCalls, 1, "the agent is asked to write the prompt");
	assert.equal(
		result.dialogs[result.dialogs.length - 1].title,
		"Steering for the hand-off prompt (sent to the current agent)",
	);
});
