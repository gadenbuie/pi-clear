// Offline regression tests: no pi process, user configuration, or model requests.
// Run with Node 24+: node --test scripts/model-picker.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import extension from "../index.ts";

const sol = { provider: "bedrock", id: "us.openai.gpt-6.1-sol", name: "Sol" };
const other = { provider: "anthropic", id: "claude-other", name: "Claude Other" };
const named = { provider: "custom", id: "opaque-id", name: "Friendly Display Name" };

async function openPicker({ scopedModels = [], model = other } = {}) {
	const commands = new Map();
	extension({
		registerCommand: (name, command) => commands.set(name, command),
		on: () => {},
	});
	let component;
	let selected;
	const notifications = [];
	await commands.get("hand-off").handler("", {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		model,
		scopedModels,
		modelRegistry: { getAvailable: () => [other, sol, named] },
		ui: {
			notify: (message) => notifications.push(message),
			custom: async (factory) => {
				component = factory(
					{ requestRender() {} },
					{ fg: (_color, text) => text, bold: (text) => text },
					getKeybindings(),
					(value) => { selected = value; },
				);
				// Stop the command before thinking/steering dialogs or model requests.
				return null;
			},
		},
	});
	assert.deepEqual(notifications, []);
	assert.ok(component, "hand-off opens the custom model picker");
	return {
		type: (text) => component.handleInput(text),
		render: () => component.render(160).join("\n"),
		get selected() { return selected; },
	};
}

test("version fragments match model IDs and Enter selects the matching model", async () => {
	const picker = await openPicker();
	picker.type("6.1");
	assert.match(picker.render(), /us\.openai\.gpt-6\.1-sol/);
	assert.doesNotMatch(picker.render(), /claude-other|opaque-id/);
	picker.type("\r");
	assert.equal(picker.selected.model, sol);
});

test("search matches providers case-insensitively", async () => {
	const picker = await openPicker();
	picker.type("BEDROCK");
	picker.type("\r");
	assert.equal(picker.selected.model, sol);
});

test("search matches display names as well as model IDs", async () => {
	const picker = await openPicker();
	picker.type("Friendly");
	picker.type("\r");
	assert.equal(picker.selected.model, named);
});

test("empty searches keep the current model selected", async () => {
	const picker = await openPicker({ model: sol });
	picker.type("\r");
	assert.equal(picker.selected.model, sol);
});

test("a query with no matches cannot select a model", async () => {
	const picker = await openPicker();
	picker.type("zzzzzzzzzz");
	assert.match(picker.render(), /No matching/);
	picker.type("\r");
	assert.equal(picker.selected, undefined);
});

test("clearing a query restores choices and current-model selection", async () => {
	const picker = await openPicker();
	picker.type("6.1");
	picker.type("\x7f");
	picker.type("\x7f");
	picker.type("\x7f");
	assert.match(picker.render(), /claude-other/);
	assert.match(picker.render(), /opaque-id/);
	picker.type("\r");
	assert.equal(picker.selected.model, other);
});

test("Tab preserves the query and switching back preserves scoped thinking levels", async () => {
	const picker = await openPicker({ scopedModels: [{ model: sol, thinkingLevel: "high" }, { model: other }] });
	picker.type("6.1");
	picker.type("\t");
	assert.match(picker.render(), /all \(3\)/);
	assert.doesNotMatch(picker.render(), /claude-other|opaque-id/);
	picker.type("\t");
	const screen = picker.render();
	assert.match(screen, /scoped \(2\)/);
	assert.ok(screen.indexOf("us.openai.gpt-6.1-sol") < screen.indexOf("enter select"), "list stays above footer after scope changes");
	picker.type("\r");
	assert.deepEqual(picker.selected, { model: sol, thinkingLevel: "high" });
});

test("Tab finds matches outside the scoped models without clearing the query", async () => {
	const picker = await openPicker({ scopedModels: [{ model: other }] });
	picker.type("6.1");
	assert.match(picker.render(), /No matching/);
	picker.type("\t");
	picker.type("\r");
	assert.equal(picker.selected.model, sol);
});
