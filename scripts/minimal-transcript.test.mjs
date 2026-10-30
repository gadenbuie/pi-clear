// Offline regression tests for the /hand-off fresh pass: no pi process, user
// configuration, or model requests.
// Run with Node 24+: node --test scripts/minimal-transcript.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildMinimalTranscript,
	buildProvenanceComment,
	formatToolHint,
	loadHandoffSettings,
	parseHandoffArgs,
	renderTranscriptBlocks,
	resolveMaxSourceChars,
} from "../index.ts";

/** A conversation shaped like `sessionManager.buildSessionProjection().messages`. */
function sampleConversation() {
	return [
		{ role: "user", content: [{ type: "text", text: "the foo suite fails after my refactor, fix it" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET-THINKING-BLOCK" },
				{ type: "text", text: "Looking at the suite and the module it covers." },
				{ type: "toolCall", name: "read", arguments: { path: "src/foo.test.ts" } },
				{ type: "toolCall", name: "read", arguments: { path: "src/foo.ts" } },
				{ type: "toolCall", name: "read", arguments: { path: "src/config.ts" } },
				{ type: "toolCall", name: "bash", arguments: { command: "npm test -- foo.test.ts\nsecond line is dropped" } },
			],
		},
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "TOOL-RESULT-BODY" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "The refactor renamed `add` to `sum` but the test still calls `add`." },
				{ type: "toolCall", name: "edit", arguments: { path: "src/foo.ts" } },
				{ type: "toolCall", name: "edit", arguments: { path: "src/foo.test.ts" } },
			],
		},
		{ role: "toolResult", toolName: "edit", content: [{ type: "text", text: "DIFF-BODY" }] },
		{ role: "assistant", content: [{ type: "text", text: "Suite passes now." }] },
	];
}

test("thinking blocks and tool results never reach the fresh pass", () => {
	const { text } = buildMinimalTranscript(sampleConversation(), 200_000);
	assert.doesNotMatch(text, /SECRET-THINKING-BLOCK/);
	assert.doesNotMatch(text, /TOOL-RESULT-BODY|DIFF-BODY/);
	assert.match(text, /\[User\]: the foo suite fails after my refactor/);
	assert.match(text, /\[Assistant\]: Looking at the suite/);
});

test("tool calls render as one-line hints, grouped per message", () => {
	const { text } = buildMinimalTranscript(sampleConversation(), 200_000);
	assert.match(
		text,
		/\[tools\]:\nread src\/foo\.test\.ts\nread src\/foo\.ts\nread src\/config\.ts\nbash: npm test -- foo\.test\.ts/,
	);
	assert.doesNotMatch(text, /second line is dropped/, "only the first bash line is kept");
	assert.doesNotMatch(text, /\[toolResult\]/);
});

test("tool hint formatting for every supported tool", () => {
	assert.equal(formatToolHint("read", { path: "src/x.ts" }), "read src/x.ts");
	assert.equal(formatToolHint("edit", { path: "src/x.ts" }), "edit src/x.ts");
	assert.equal(formatToolHint("write", { path: "docs/y.md" }), "write docs/y.md");
	assert.equal(formatToolHint("bash", { command: "npm test\nmore" }), "bash: npm test");
	assert.equal(formatToolHint("bash", { command: "x".repeat(400) }), `bash: ${"x".repeat(200)}`);
	assert.equal(formatToolHint("grep", { pattern: "fail.*assert", path: "src/" }), "grep: /fail.*assert/ in src/");
	assert.equal(formatToolHint("grep", { pattern: "fail.*assert" }), "grep: /fail.*assert/");
	assert.equal(formatToolHint("find", { pattern: "*.test.ts", path: "src" }), "find: *.test.ts in src");
	assert.equal(formatToolHint("ls", { path: "src" }), "ls: src");
	assert.equal(formatToolHint("web_fetch", { url: "https://example.com" }), "tool: web_fetch https://example.com");
	assert.equal(formatToolHint("mystery", {}), "tool: mystery");
});

test("file-operation footer matches pi's compaction rules", () => {
	const { text } = buildMinimalTranscript(sampleConversation(), 200_000);
	// Only files that were never modified land in <read-files>.
	assert.match(text, /<read-files>\nsrc\/config\.ts\n<\/read-files>/);
	assert.doesNotMatch(text, /<read-files>[^<]*src\/foo\.test\.ts/);
	assert.match(text, /<modified-files>\nsrc\/foo\.test\.ts\nsrc\/foo\.ts\n<\/modified-files>/);
	assert.equal(text.endsWith("</modified-files>"), true);
});

test("custom messages are noted, stale hand-off requests are dropped", () => {
	const { text } = buildMinimalTranscript(
		[
			{ role: "user", content: "hello" },
			{ role: "custom", customType: "pi-clear:hand-off-request", content: "STALE-REQUEST" },
			{ role: "custom", customType: "other:note", content: "REMEMBER-THIS" },
			{ role: "bashExecution", command: "git status", output: "BASH-OUTPUT" },
			{ role: "compactionSummary", summary: "EARLIER-WORK" },
			{ role: "branchSummary", summary: "SIDE-BRANCH" },
		],
		200_000,
	);
	assert.doesNotMatch(text, /STALE-REQUEST/);
	assert.doesNotMatch(text, /BASH-OUTPUT/);
	assert.match(text, /\[Note\]: REMEMBER-THIS/);
	assert.match(text, /\[User ran\]: git status/);
	assert.match(text, /\[Summary of earlier conversation\]: EARLIER-WORK/);
	assert.match(text, /\[Summary of earlier conversation\]: SIDE-BRANCH/);
});

function longConversation(turns) {
	const messages = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "user", content: `question ${i} ${"u".repeat(120)}` });
		messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i} ${"a".repeat(120)}` }] });
	}
	return messages;
}

test("over-budget conversations keep the head and the tail, and mark the gap", () => {
	const messages = longConversation(20);
	const full = buildMinimalTranscript(messages, 0).text;
	const trimmed = buildMinimalTranscript(messages, 1_500);

	assert.ok(trimmed.text.length > 0);
	assert.ok(trimmed.omittedTurns > 0, "some turns are omitted");
	assert.ok(trimmed.droppedChars > 0, "dropped characters are counted");
	assert.match(
		trimmed.text,
		new RegExp(`\\[\\.\\.\\. ${trimmed.omittedTurns} turns omitted — ${trimmed.droppedChars} chars \\.\\.\\.\\]`),
	);
	assert.match(trimmed.text, /\[User\]: question 0 /, "the first user message is always kept");
	assert.match(trimmed.text, /answer 18|answer 19/, "the newest turn is kept");
	assert.doesNotMatch(trimmed.text, /\[Assistant\]: answer 5 /, "a middle turn is dropped");
	assert.ok(trimmed.text.length < full.length);
});

test("a budget of 0 disables trimming", () => {
	const messages = longConversation(20);
	const { text, omittedTurns, droppedChars } = buildMinimalTranscript(messages, 0);
	assert.equal(omittedTurns, 0);
	assert.equal(droppedChars, 0);
	assert.match(text, /\[User\]: question 0 /);
	assert.match(text, /\[Assistant\]: answer 19 /);
	assert.doesNotMatch(text, /turns omitted/);
});

test("a conversation that fits is emitted verbatim", () => {
	const messages = longConversation(2);
	const rendered = renderTranscriptBlocks(messages)
		.map((block) => block.text)
		.join("\n\n");
	const { text, omittedTurns } = buildMinimalTranscript(messages, 200_000);
	assert.equal(omittedTurns, 0);
	assert.ok(text.startsWith(rendered));
	assert.doesNotMatch(text, /turns omitted|chars truncated/);
});

test("over-long messages are truncated head and tail, never dropped", () => {
	const long = `${"H".repeat(6_000)}\nMIDDLE\n${"T".repeat(6_000)}`;
	const { text } = buildMinimalTranscript([{ role: "user", content: long }], 200_000);
	assert.match(text, /^\[User\]: H+/);
	assert.match(text, /\[\.\.\. \d+ chars truncated \.\.\.\]/);
	assert.match(text, /T+\s*$/);
});

test("provenance is a bare comment naming the source session", () => {
	assert.equal(
		buildProvenanceComment("01a18da2-4eff-73b9-846d-5fd4c156e52e"),
		"<!-- Handed off from pi session 01a18da2-4eff-73b9-846d-5fd4c156e52e -->",
	);
	assert.equal(buildProvenanceComment("  padded-id  "), "<!-- Handed off from pi session padded-id -->");
	assert.equal(buildProvenanceComment(undefined), "");
	assert.equal(buildProvenanceComment(""), "");
	// The full id is printed: no other tool is assumed to be installed.
	assert.doesNotMatch(buildProvenanceComment("01a18da2-4eff"), /pirecall|Raw transcript/);
});

test("command args: flags are parsed off the front and the rest is steering", () => {
	assert.deepEqual(parseHandoffArgs(""), { steering: "" });
	assert.deepEqual(parseHandoffArgs("  keep going  "), { steering: "keep going" });
	assert.deepEqual(parseHandoffArgs("--fresh keep going"), { writer: "fresh", steering: "keep going" });
	assert.deepEqual(parseHandoffArgs("--live focus on tests"), { writer: "live", steering: "focus on tests" });
	assert.deepEqual(parseHandoffArgs("--fresh --summarizer=anthropic/claude-haiku-4-5 go"), {
		writer: "fresh",
		summarizerModel: "anthropic/claude-haiku-4-5",
		steering: "go",
	});
	assert.deepEqual(parseHandoffArgs("--summarizer=openai/gpt-5.2"), {
		summarizerModel: "openai/gpt-5.2",
		steering: "",
	});
	// Flags only count at the front; steering text is otherwise left alone.
	assert.deepEqual(parseHandoffArgs("mention --fresh"), { steering: "mention --fresh" });
	assert.match(parseHandoffArgs("--fresh --live").error ?? "", /cannot be combined/);
	assert.match(parseHandoffArgs("--summarizer").error ?? "", /needs a value/);
	assert.match(parseHandoffArgs("--summarizer=noslash").error ?? "", /provider\/model/);
});

test("settings resolve command flag > file > default", () => {
	assert.equal(resolveMaxSourceChars("5000", {}), 5000);
	assert.equal(resolveMaxSourceChars("0", { maxSourceChars: 200 }), 0, "0 disables the budget");
	assert.equal(resolveMaxSourceChars(undefined, { maxSourceChars: 1234 }), 1234);
	assert.equal(resolveMaxSourceChars(undefined, {}), 200_000);
	assert.equal(resolveMaxSourceChars("not a number", {}), 200_000);
});

test("a malformed settings file warns instead of throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-clear-settings-"));
	const path = join(dir, "pi-clear.json");
	writeFileSync(path, "{ not json");
	const broken = loadHandoffSettings(path);
	assert.deepEqual(broken.settings, {});
	assert.match(broken.warning ?? "", /ignoring malformed/);
	assert.deepEqual(loadHandoffSettings(join(dir, "missing.json")), { settings: {} });

	writeFileSync(
		path,
		JSON.stringify({ handoff: { summarizerModel: "anthropic/claude-haiku-4-5", askSummarizerModel: false, maxSourceChars: 0 } }),
	);
	assert.deepEqual(loadHandoffSettings(path), {
		settings: { summarizerModel: "anthropic/claude-haiku-4-5", askSummarizerModel: false, maxSourceChars: 0 },
	});

	writeFileSync(path, JSON.stringify({ handoff: { summarizerModel: 42, maxSourceChars: -1 } }));
	const invalid = loadHandoffSettings(path);
	assert.deepEqual(invalid.settings, {});
	assert.match(invalid.warning ?? "", /summarizerModel/);
	assert.match(invalid.warning ?? "", /maxSourceChars/);
});
