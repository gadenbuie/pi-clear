/**
 * pi-clear — `/clear` and `/hand-off` for pi.
 *
 * `/clear`: start a fresh session without losing your model.
 *
 * The built-in `/new` command starts a new session, but the new runtime
 * resolves its model from the defaults chain (CLI args → scoped models →
 * saved default in settings → first available model with auth). A model you
 * switched to mid-session — via `/model`, `pi.setModel()`, or model cycling —
 * is recorded as a `model_change` entry in the *current* session transcript,
 * so it never reaches the new session.
 *
 * `/clear` starts an equally fresh session, then restores the model and
 * thinking level that were active when you cleared.
 *
 * `/hand-off`: hand the conversation to another model.
 *
 * 1. The user runs `/hand-off`, optionally with flags (`--fresh`, `--live`,
 *    `--summarizer=provider/model`) and steering text after them.
 * 2. A dialog flow asks who writes the hand-off prompt, then collects the
 *    destination model and thinking level, then opens an editor pre-filled
 *    with the remaining command args.
 * 3. The hand-off prompt is written by one of two writers:
 *    - the **live agent** (default, first in the picker): the extension sends
 *      the current agent a custom message asking it to write its next message
 *      as the hand-off prompt, and `agent_end` captures the final assistant
 *      message. It sees the whole transcript and keeps tool access.
 *    - the **fresh pass**: a single out-of-band `modelRegistry.complete()`
 *      call over a *minimal reconstruction* of the conversation (no tool
 *      output, no thinking, head+tail budget), so long or stale sessions can
 *      still be handed off, and a cheap model can do the writing. It has no
 *      tool access.
 * 4. The extension prepends a provenance comment naming the source session
 *    (both writers), replaces the session, applies the chosen model and
 *    thinking level, and inserts the prompt into the editor.
 * 5. The user reviews, edits, and submits the prompt themselves.
 *
 * Settings live in `<agent-dir>/pi-clear.json` (read once per
 * `session_start`); CLI flags `--hand-off-max-source-chars` and
 * `--hand-off-summarizer` override the file. Precedence for the summarizer
 * model: command arg > CLI flag > config file > current model.
 *
 * Mechanism:
 *   Both commands capture state as plain data into a `globalThis` property.
 *   Session replacement (`ctx.newSession()`) tears down the current runtime
 *   and recreates extension instances, but stays within the same process, so
 *   a `globalThis` property safely crosses that boundary while remaining
 *   invisible to other pi processes and dying with crashes.
 *
 *   The new instance's `session_start` handler (reason: "new") consumes the
 *   handoff and applies the model and thinking level via `pi.setModel()` /
 *   `pi.setThinkingLevel()`, which record them in the new session so they
 *   also survive `/resume`. If the handoff carries a prompt, it is inserted
 *   into the editor with `ctx.ui.setEditorText()`.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

// Model and thinking-level types, derived from the API surface because the
// package root does not re-export them directly.
type AnyModel = Parameters<ExtensionAPI["setModel"]>[0];
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

/** State carried across session replacement via `globalThis`. */
interface SessionHandoff {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	/** When present, inserted into the new session's editor (`/hand-off`). */
	prompt?: string;
}

const HANDOFF_KEY = "__pi_clear_handoff__";

function writeHandoff(handoff: SessionHandoff): void {
	(globalThis as Record<string, unknown>)[HANDOFF_KEY] = handoff;
}

/** Consume the handoff: read it and remove it so it can only apply once. */
function takeHandoff(): SessionHandoff | undefined {
	const store = globalThis as Record<string, unknown>;
	const handoff = store[HANDOFF_KEY];
	delete store[HANDOFF_KEY];
	return handoff as SessionHandoff | undefined;
}

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const HANDOFF_CUSTOM_TYPE = "pi-clear:hand-off-request";

function sameModel(a: AnyModel | undefined, b: AnyModel | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function modelLabel(model: AnyModel, current: AnyModel | undefined): string {
	return `${model.provider}/${model.id}${sameModel(model, current) ? "  (current)" : ""}`;
}

/** Match a dialog result against option labels, tolerating "  (current)"-style decorations. */
function labelIndex(chosen: string, labels: string[]): number {
	const exact = labels.indexOf(chosen);
	if (exact !== -1) return exact;
	const bare = chosen.split("  (")[0];
	return labels.findIndex((label) => label === bare || label.startsWith(`${bare}  (`));
}

function orderCurrentFirst<T>(
	items: T[],
	current: AnyModel | undefined,
	getModel: (item: T) => AnyModel,
): T[] {
	if (!current) return items;
	const first = items.filter((item) => sameModel(getModel(item), current));
	const rest = items.filter((item) => !sameModel(getModel(item), current));
	return [...first, ...rest];
}

/** A hand-off destination: the model plus an optional scope-pinned thinking level. */
interface PickedModel {
	model: AnyModel;
	thinkingLevel?: ThinkingLevel;
}

/** How the model pickers label themselves and which model they treat as current. */
interface ModelPickerOptions {
	/** Preselected model; defaults to the session's model. */
	current?: AnyModel;
	title?: string;
	providerTitle?: string;
}

async function selectModel(
	ctx: ExtensionContext,
	models: AnyModel[],
	title: string,
	current: AnyModel | undefined,
): Promise<AnyModel | undefined> {
	if (models.length === 1) return models[0];
	const ordered = orderCurrentFirst(models, current, (m) => m);
	const labels = ordered.map((m) => modelLabel(m, current));
	const chosen = await ctx.ui.select(title, labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === -1 ? undefined : ordered[index];
}

/**
 * Thinking level picker with the active level preselected, so Enter accepts
 * the current setting.
 */
async function selectThinkingLevel(ctx: ExtensionContext): Promise<ThinkingLevel | undefined> {
	const current = ctx.thinkingLevel;
	const ordered = current
		? [current, ...THINKING_LEVELS.filter((level) => level !== current)]
		: [...THINKING_LEVELS];
	const labels = ordered.map((level) => `${level}${level === current ? "  (current)" : ""}`);
	const chosen = await ctx.ui.select("Thinking level", labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === -1 ? undefined : ordered[index];
}

/**
 * Non-interactive fallback (RPC mode has no custom components): scoped
 * models in one dialog when scoping is configured, otherwise a two-level
 * provider → model pick over the auth-configured catalogue.
 */
async function pickTargetModelFallback(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<PickedModel | undefined> {
	const current = options.current ?? ctx.model;
	const title = options.title ?? "Hand off to model";
	const providerTitle = options.providerTitle ?? "Hand off to provider";
	const scoped = ctx.scopedModels.map((scoped) => scoped.model);

	if (scoped.length > 0) {
		// Keep the current model selectable and preselected even when scoping
		// excludes it.
		const models = current && !scoped.some((m) => sameModel(m, current)) ? [current, ...scoped] : scoped;
		const model = await selectModel(ctx, models, title, current);
		return model ? { model } : undefined;
	}

	const available = ctx.modelRegistry.getAvailable();
	const usable = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
	const models = usable.length > 0 ? usable : available;
	if (models.length === 0) {
		ctx.ui.notify("No models available to hand off to", "error");
		return undefined;
	}

	const byProvider = new Map<string, AnyModel[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}
	const providers = [...byProvider.keys()].sort();
	if (current && byProvider.has(current.provider)) {
		providers.splice(providers.indexOf(current.provider), 1);
		providers.unshift(current.provider);
	}

	const providerLabels = providers.map((p) => `${p}  (${byProvider.get(p)!.length} models)`);
	const providerChoice =
		providers.length === 1 ? providerLabels[0] : await ctx.ui.select(providerTitle, providerLabels);
	if (providerChoice === undefined) return undefined;
	const providerIndex = labelIndex(providerChoice, providerLabels);
	if (providerIndex === -1) return undefined;
	const providerName = providers[providerIndex];

	const model = await selectModel(ctx, byProvider.get(providerName) ?? [], title, current);
	return model ? { model } : undefined;
}

/**
 * `/model`-style model picker (TUI mode only): a searchable list with Tab to
 * toggle between the session's scoped models and the full catalogue.
 */
async function pickTargetModelTui(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<PickedModel | undefined> {
	const current = options.current ?? ctx.model;
	const title = options.title ?? "Hand off to model";
	const allEntries: PickedModel[] = ctx.modelRegistry.getAvailable().map((model) => ({ model }));
	if (allEntries.length === 0) {
		ctx.ui.notify("No models available to hand off to", "error");
		return undefined;
	}

	// Scoped entries may pin a thinking level (`provider/model:high`); dedupe
	// by provider/id, keeping the first entry's pinned level.
	const scopedByKey = new Map<string, PickedModel>();
	for (const scoped of ctx.scopedModels) {
		const key = `${scoped.model.provider}/${scoped.model.id}`;
		if (!scopedByKey.has(key)) {
			scopedByKey.set(key, { model: scoped.model, thinkingLevel: scoped.thinkingLevel });
		}
	}
	const scopedEntries = [...scopedByKey.values()];

	if (allEntries.length === 1) return allEntries[0];

	const result = await ctx.ui.custom<PickedModel | null>((tui, theme, kb, done) => {
		const MAX_VISIBLE = 12;
		let scope: "scoped" | "all" = scopedEntries.length > 0 ? "scoped" : "all";
		let selectList: SelectList;

		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};

		const entriesForScope = () => (scope === "scoped" ? scopedEntries : allEntries);

		const makeList = (query = "") => {
			const ordered = orderCurrentFirst(entriesForScope(), current, (entry) => entry.model);
			// SelectList.setFilter() only prefix-matches item values, not labels.
			const entries = fuzzyFilter(ordered, query, ({ model }) => `${model.provider} ${model.id} ${model.name}`);
			const items: SelectItem[] = entries.map((entry, index) => ({
				value: String(index),
				label: modelLabel(entry.model, current),
				description: entry.model.name,
			}));
			const list = new SelectList(items, MAX_VISIBLE, listTheme);
			list.onSelect = (item) => done(entries[Number(item.value)] ?? null);
			list.onCancel = () => done(null);
			return list;
		};

		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		const header = new Text("");
		container.addChild(header);
		const searchInput = new Input({ placeholder: "Type to filter" });
		container.addChild(searchInput);
		const listContainer = new Container();
		selectList = makeList();
		listContainer.addChild(selectList);
		container.addChild(listContainer);
		const updateList = () => {
			selectList = makeList(searchInput.getValue());
			listContainer.clear();
			listContainer.addChild(selectList);
		};
		const hint = new Text("");
		container.addChild(hint);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		const updateChrome = () => {
			header.setText(
				theme.fg(
					"accent",
					theme.bold(
						`${title} — ${scope === "scoped" ? `scoped (${scopedEntries.length})` : `all (${allEntries.length})`}`,
					),
				),
			);
			const parts = ["type to filter", "enter select", "esc cancel"];
			if (scopedEntries.length > 0) {
				parts.unshift(`tab → ${scope === "scoped" ? "all models" : "scoped"}`);
			}
			hint.setText(theme.fg("dim", parts.join(" • ")));
		};
		updateChrome();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (scopedEntries.length > 0 && kb.matches(data, "tui.input.tab")) {
					scope = scope === "scoped" ? "all" : "scoped";
					updateList();
					updateChrome();
					tui.requestRender();
					return;
				}
				if (
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.confirm") ||
					kb.matches(data, "tui.select.cancel")
				) {
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				searchInput.handleInput(data);
				updateList();
				tui.requestRender();
			},
		};
	});

	return result ?? undefined;
}

/**
 * Pick the hand-off destination model without flooding the screen.
 *
 * TUI mode gets a `/model`-style searchable picker with Tab to toggle
 * between scoped and all models; other modes fall back to plain dialogs.
 * The same picker also chooses the fresh pass's writer model, with the
 * title and preselected model supplied by the caller.
 */
async function pickTargetModel(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<PickedModel | undefined> {
	if (ctx.mode === "tui") {
		return pickTargetModelTui(ctx, options);
	}
	return pickTargetModelFallback(ctx, options);
}

/** Extract the text content of an agent message, ignoring thinking blocks and tool calls. */
function messageText(message: { role: string; content: string | Array<{ type: string; text?: string }> }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function buildHandoffRequest(steering: string): string {
	const lines = [
		"The user is handing this conversation off to a different model. Your next assistant message will be copied verbatim and submitted as the first user message of a brand-new session that has no memory of this conversation.",
		"",
		"Write that hand-off message now. It must:",
		"- Be written as instructions to the next agent (\"you\"), not a report about this conversation.",
		"- Assume the next agent has zero prior context: carry forward the current task and goal, what has been done so far (with concrete file paths, commands, and key decisions), and exactly what to do next.",
	];
	if (steering.trim()) {
		lines.push(
			"",
			"Additional guidance from the user for what the hand-off must cover:",
			"",
			steering.trim(),
		);
	}
	lines.push(
		"",
		"Output rules: reply with ONLY the hand-off message itself. No preamble, no postamble, no surrounding markdown fences, no explanations, no questions.",
	);
	return lines.join("\n");
}

// ============================================================================
// Fresh pass: one out-of-band model call over a minimal reconstruction
// ============================================================================

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. You will receive a minimal reconstruction of a long conversation between a user and an AI agent, and you must write the hand-off message that starts the next session.

Do not continue the conversation. Do not answer questions in it.

The reconstruction is lossy: tool output, thinking, and file contents are omitted, and a middle section may be elided. Do not assert file contents or the state of the working tree from memory — when something cannot be verified from the transcript, tell the next agent to verify it.`;

const DEFAULT_COVERAGE =
	"Cover the conversation thoroughly: the current task and goal, what has been done so far (with concrete file paths, commands, and decisions), and exactly what to do next.";

/** Characters of conversation sent to the fresh pass (~50k tokens at 200k). */
const DEFAULT_MAX_SOURCE_CHARS = 200_000;
/** Share of the budget kept from the newest end of the conversation. */
const TAIL_SOURCE_SHARE = 0.6;
/** Share of the budget kept contiguously after the opening message. */
const HEAD_SOURCE_SHARE = 0.4;
const USER_MESSAGE_MAX_CHARS = 8_000;
const ASSISTANT_MESSAGE_MAX_CHARS = 4_000;
const SUMMARY_MAX_CHARS = 8_000;
const NOTE_MAX_CHARS = 2_000;
const HINT_MAX_CHARS = 200;

/** A projected session message, viewed loosely: only fields the serializer reads. */
interface TranscriptSource {
	role?: string;
	content?: unknown;
	customType?: string;
	summary?: string;
	command?: string;
	/** `!!` bash executions: never sent to a model, so never sent to the writer. */
	excludeFromContext?: boolean;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

/** One rendered unit of the minimal transcript; the budget never splits a block. */
interface TranscriptBlock {
	text: string;
	/** Marks the opening user message, which the budget always keeps. */
	anchor?: boolean;
}

interface TranscriptResult {
	text: string;
	/** Blocks dropped from the middle of the conversation, 0 when nothing was dropped. */
	omittedTurns: number;
	/** Characters those blocks would have contributed. */
	droppedChars: number;
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null) blocks.push(block as ContentBlock);
	}
	return blocks;
}

/** Visible text only: thinking, tool calls, and images are dropped. */
function visibleText(content: unknown): string {
	return contentBlocks(content)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter((text) => text.length > 0)
		.join("\n");
}

function toolCallsOf(content: unknown): ContentBlock[] {
	return contentBlocks(content).filter(
		(block) => block.type === "toolCall" && typeof block.name === "string",
	);
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstStringArg(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	for (const value of Object.values(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** Keep both ends of an over-long text, and say how much was cut. */
function truncateMiddle(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * TAIL_SOURCE_SHARE);
	const tailChars = maxChars - headChars;
	const removed = text.length - maxChars;
	return `${text.slice(0, headChars)}\n[... ${removed} chars truncated ...]\n${text.slice(text.length - tailChars)}`;
}

/** One line naming a tool call and its target — never its result. */
export function formatToolHint(name: string, args: unknown): string {
	const path = stringArg(args, "path");
	switch (name) {
		case "read":
		case "edit":
		case "write":
			return path ? `${name} ${path}` : name;
		case "bash": {
			const command = stringArg(args, "command")?.split("\n")[0].trim() ?? "";
			return command ? `bash: ${command.slice(0, HINT_MAX_CHARS)}` : "bash";
		}
		case "grep": {
			const pattern = stringArg(args, "pattern");
			if (!pattern) return "grep";
			return path ? `grep: /${pattern}/ in ${path}` : `grep: /${pattern}/`;
		}
		case "ls":
			return path ? `ls: ${path}` : "ls";
		case "find": {
			const pattern = stringArg(args, "pattern");
			if (pattern && path) return `find: ${pattern} in ${path}`;
			if (path) return `find: ${path}`;
			return pattern ? `find: ${pattern}` : "find";
		}
		default: {
			const detail = path ?? firstStringArg(args);
			return detail ? `tool: ${name} ${detail.slice(0, HINT_MAX_CHARS)}` : `tool: ${name}`;
		}
	}
}

interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

/** Same rules pi uses for compaction: read-only files, then written/edited ones. */
function fileListsFromMessages(messages: readonly TranscriptSource[]): FileLists {
	const read = new Set<string>();
	const written = new Set<string>();
	const edited = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of toolCallsOf(message.content)) {
			const path = stringArg(call.arguments, "path");
			if (!path) continue;
			if (call.name === "read") read.add(path);
			else if (call.name === "write") written.add(path);
			else if (call.name === "edit") edited.add(path);
		}
	}
	const modified = new Set([...edited, ...written]);
	return {
		readFiles: [...read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function formatFileLists(lists: FileLists): string {
	const sections: string[] = [];
	if (lists.readFiles.length > 0) sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
	if (lists.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.join("\n\n");
}

/**
 * Render the conversation as labelled blocks: visible text, tool-call hints,
 * summaries, and notes. Tool results, thinking, and stale hand-off requests
 * are dropped outright.
 */
export function renderTranscriptBlocks(messages: readonly TranscriptSource[]): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	let sawUserMessage = false;

	for (const message of messages) {
		switch (message.role) {
			case "user": {
				const text = visibleText(message.content);
				if (!text) break;
				blocks.push({
					text: `[User]: ${truncateMiddle(text, USER_MESSAGE_MAX_CHARS)}`,
					anchor: !sawUserMessage,
				});
				sawUserMessage = true;
				break;
			}
			case "assistant": {
				const text = visibleText(message.content);
				if (text) {
					blocks.push({ text: `[Assistant]: ${truncateMiddle(text, ASSISTANT_MESSAGE_MAX_CHARS)}` });
				}
				const hints = toolCallsOf(message.content).map((call) => formatToolHint(call.name!, call.arguments));
				if (hints.length > 0) blocks.push({ text: `[tools]:\n${hints.join("\n")}` });
				break;
			}
			case "toolResult":
				// Tool output never shapes the hand-off: it is the bulk of a transcript
				// and the writer is told to have the next agent verify state itself.
				break;
			case "custom": {
				if (message.customType === HANDOFF_CUSTOM_TYPE) break;
				const text = visibleText(message.content);
				if (text) blocks.push({ text: `[Note]: ${truncateMiddle(text, NOTE_MAX_CHARS)}` });
				break;
			}
			case "compactionSummary":
			case "branchSummary": {
				const summary = typeof message.summary === "string" ? message.summary.trim() : "";
				if (summary) {
					blocks.push({
						text: `[Summary of earlier conversation]: ${truncateMiddle(summary, SUMMARY_MAX_CHARS)}`,
					});
				}
				break;
			}
			case "bashExecution": {
				if (message.excludeFromContext) break;
				const command = typeof message.command === "string" ? message.command.trim() : "";
				if (command) blocks.push({ text: `[User ran]: ${truncateMiddle(command, NOTE_MAX_CHARS)}` });
				break;
			}
			default:
				break;
		}
	}

	return blocks;
}

/**
 * Keep the head and the tail of the conversation within `maxChars`, dropping
 * the middle and leaving an elision marker in its place. `maxChars <= 0`
 * disables the budget.
 */
export function applyTranscriptBudget(blocks: readonly TranscriptBlock[], maxChars: number): TranscriptResult {
	const parts = blocks.map((block) => block.text);
	const joinBlocks = (items: string[]) => items.join("\n\n");
	const full = joinBlocks(parts);
	if (maxChars <= 0 || full.length <= maxChars) {
		return { text: full, omittedTurns: 0, droppedChars: 0 };
	}

	// Head: everything up to and including the opening user message, always kept.
	const anchor = blocks.findIndex((block) => block.anchor);
	const anchorIndex = anchor === -1 ? 0 : anchor;
	let headChars = parts.slice(0, anchorIndex + 1).reduce((sum, part) => sum + part.length + 2, 0);

	// Tail: newest first, up to 60% of the budget.
	const tailBudget = Math.floor(maxChars * TAIL_SOURCE_SHARE);
	let tailStart = parts.length;
	let tailChars = 0;
	for (let i = parts.length - 1; i > anchorIndex; i--) {
		const cost = parts[i].length + 2;
		if (tailChars + cost > tailBudget) break;
		tailChars += cost;
		tailStart = i;
	}
	// Never drop the newest block: it is the most valuable one, and message-level
	// caps normally keep it well inside the tail budget.
	if (tailStart === parts.length && parts.length > anchorIndex + 1) tailStart = parts.length - 1;

	// Gap: oldest first, contiguous from just after the head, while the head
	// budget lasts.
	const headBudget = Math.floor(maxChars * HEAD_SOURCE_SHARE);
	let gapEnd = anchorIndex;
	while (gapEnd + 1 < tailStart && headChars + parts[gapEnd + 1].length + 2 <= headBudget) {
		headChars += parts[gapEnd + 1].length + 2;
		gapEnd += 1;
	}

	const omitted = parts.slice(gapEnd + 1, tailStart);
	const droppedChars = omitted.reduce((sum, part) => sum + part.length + 2, 0);
	const kept = [...parts.slice(0, gapEnd + 1)];
	if (omitted.length > 0) kept.push(`[... ${omitted.length} turns omitted — ${droppedChars} chars ...]`);
	kept.push(...parts.slice(tailStart));

	return { text: joinBlocks(kept), omittedTurns: omitted.length, droppedChars };
}

/** Minimal reconstruction of the conversation plus the file-operation footer. */
export function buildMinimalTranscript(
	messages: readonly TranscriptSource[],
	maxChars: number = DEFAULT_MAX_SOURCE_CHARS,
): TranscriptResult {
	const budget = applyTranscriptBudget(renderTranscriptBlocks(messages), maxChars);
	const fileLists = formatFileLists(fileListsFromMessages(messages));
	if (!fileLists) return budget;
	return { ...budget, text: budget.text ? `${budget.text}\n\n${fileLists}` : fileLists };
}

/** The single user message of the fresh pass. */
export function buildFreshPassUserMessage(transcript: string, steering: string): string {
	return [
		"## Conversation (minimal reconstruction)",
		transcript,
		"",
		"## What the hand-off must cover",
		steering.trim() || DEFAULT_COVERAGE,
		"",
		"Requirements for your output:",
		'- Written as instructions to the next agent ("you"), not a report about the past.',
		"- Assume zero prior context: current task and goal, what was done so far with concrete file paths, commands, and decisions, and exactly what to do next.",
		"- Name the files worth opening first.",
		"- Reply with ONLY the hand-off message: no preamble, no postamble, no fences.",
	].join("\n");
}

// ============================================================================
// Session provenance (both writers)
// ============================================================================

/**
 * HTML comment naming the session a hand-off came from, so the next agent can
 * look it up when the prompt is not enough. It is a comment, not prose, so it
 * does not read as part of the task, and it stays visible in the editor.
 */
export function buildProvenanceComment(sessionId: string | undefined): string {
	const id = sessionId?.trim();
	return id ? `<!-- Handed off from pi session ${id} -->` : "";
}

/** Prepends the provenance comment; called right before `writeHandoff()`. */
function withSessionProvenance(prompt: string, ctx: ExtensionContext): string {
	const comment = buildProvenanceComment(ctx.sessionManager.getSessionId());
	return comment ? `${comment}\n\n${prompt}` : prompt;
}

// ============================================================================
// Fresh pass generation
// ============================================================================

interface WriterOutcome {
	prompt?: string;
	error?: string;
	cancelled?: boolean;
}

/** Strip a fence that wraps the whole reply, leaving inner code blocks alone. */
function stripSurroundingFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
	const withoutOpen = trimmed.replace(/^```[^\n]*\n?/, "");
	return withoutOpen.slice(0, withoutOpen.lastIndexOf("```")).trim();
}

function checkWrittenPrompt(response: { stopReason?: string; errorMessage?: string; content?: unknown }): WriterOutcome {
	if (response.stopReason === "aborted") return { cancelled: true };
	if (response.stopReason !== "stop") {
		const detail = response.errorMessage ? `: ${response.errorMessage}` : "";
		return { error: `stopped with reason "${response.stopReason}"${detail}` };
	}
	const text = stripSurroundingFence(visibleText(response.content));
	if (!text) return { error: "returned an empty prompt" };
	return { prompt: text };
}

function reportWriterOutcome(ctx: ExtensionContext, outcome: WriterOutcome, label: string): string | undefined {
	if (outcome.prompt) return outcome.prompt;
	if (outcome.cancelled) {
		ctx.ui.notify("Hand-off cancelled", "info");
		return undefined;
	}
	ctx.ui.notify(
		`Hand-off writer (${label}) ${outcome.error ?? "failed"}; staying in this session`,
		"error",
	);
	return undefined;
}

/**
 * Run the fresh pass: one `complete()` call over the minimal transcript.
 * TUI mode gets a cancellable loader; other modes get a notification.
 */
async function generateFreshPassPrompt(
	ctx: ExtensionContext,
	model: AnyModel,
	transcript: string,
	steering: string,
): Promise<string | undefined> {
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: buildFreshPassUserMessage(transcript, steering) }],
		timestamp: Date.now(),
	};

	const attempt = async (signal?: AbortSignal): Promise<WriterOutcome> => {
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
				{ signal, cacheRetention: "none", sessionId: randomUUID() },
			);
			return checkWrittenPrompt(response);
		} catch (err) {
			return { error: `failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	};

	const label = `${model.provider}/${model.id}`;

	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Writing the hand-off prompt with ${label}…`, "info");
		return reportWriterOutcome(ctx, await attempt(), label);
	}

	let aborted = false;
	let outcome: WriterOutcome | undefined;
	const prompt = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		// Abort and completion can race; `done` must only be called once.
		let finished = false;
		const finish = (value: string | null) => {
			if (finished) return;
			finished = true;
			done(value);
		};
		const loader = new BorderedLoader(tui, theme, `Writing the hand-off prompt with ${label}…`);
		loader.onAbort = () => {
			aborted = true;
			finish(null);
		};
		void attempt(loader.signal).then((result) => {
			outcome = result;
			finish(result.prompt ?? null);
		});
		return loader;
	});

	if (prompt) return prompt;
	if (aborted) {
		ctx.ui.notify("Hand-off cancelled", "info");
		return undefined;
	}
	return reportWriterOutcome(ctx, outcome ?? { error: "returned no prompt" }, label);
}

// ============================================================================
// Command arguments, writer choice, and settings
// ============================================================================

interface ParsedHandoffArgs {
	writer?: "live" | "fresh";
	summarizerModel?: string;
	/** Everything after the leading flags: the steering-editor prefill. */
	steering: string;
	error?: string;
}

/** Parse leading `/hand-off` flags; the first unrecognized token starts the steering text. */
export function parseHandoffArgs(args: string): ParsedHandoffArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const parsed: ParsedHandoffArgs = { steering: "" };
	let index = 0;

	for (; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--fresh" || token === "--live") {
			const writer = token === "--fresh" ? "fresh" : "live";
			if (parsed.writer && parsed.writer !== writer) {
				return { ...parsed, error: "--fresh and --live cannot be combined; nothing was sent" };
			}
			parsed.writer = writer;
			continue;
		}
		if (token === "--summarizer") {
			return { ...parsed, error: "--summarizer needs a value: /hand-off --summarizer=provider/model" };
		}
		if (token.startsWith("--summarizer=")) {
			const value = token.slice("--summarizer=".length).trim();
			if (!value.includes("/")) {
				return { ...parsed, error: `--summarizer needs provider/model, got "${value}"` };
			}
			parsed.summarizerModel = value;
			continue;
		}
		break;
	}

	parsed.steering = tokens.slice(index).join(" ");
	return parsed;
}

export interface HandoffSettings {
	summarizerModel?: string;
	askSummarizerModel?: boolean;
	maxSourceChars?: number;
}

const SETTINGS_FILE_NAME = "pi-clear.json";
const FLAG_MAX_SOURCE_CHARS = "hand-off-max-source-chars";
const FLAG_SUMMARIZER = "hand-off-summarizer";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read `<agent-dir>/pi-clear.json`; a malformed file is a warning, not a failure. */
export function loadHandoffSettings(path: string = join(getAgentDir(), SETTINGS_FILE_NAME)): {
	settings: HandoffSettings;
	warning?: string;
} {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return { settings: {} };
		return { settings: {}, warning: `pi-clear: could not read ${path}: ${messageOf(err)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { settings: {}, warning: `pi-clear: ignoring malformed ${path}: ${messageOf(err)}` };
	}

	if (!isRecord(parsed) || !isRecord(parsed.handoff)) {
		return { settings: {}, warning: `pi-clear: ignoring ${path}: expected a "handoff" object` };
	}

	const handoff = parsed.handoff;
	const settings: HandoffSettings = {};
	const problems: string[] = [];

	if (handoff.summarizerModel !== undefined) {
		if (typeof handoff.summarizerModel === "string" && handoff.summarizerModel.includes("/")) {
			settings.summarizerModel = handoff.summarizerModel.trim();
		} else {
			problems.push('"summarizerModel" must be a "provider/model" string');
		}
	}
	if (handoff.askSummarizerModel !== undefined) {
		if (typeof handoff.askSummarizerModel === "boolean") settings.askSummarizerModel = handoff.askSummarizerModel;
		else problems.push('"askSummarizerModel" must be true or false');
	}
	if (handoff.maxSourceChars !== undefined) {
		if (typeof handoff.maxSourceChars === "number" && Number.isFinite(handoff.maxSourceChars) && handoff.maxSourceChars >= 0) {
			settings.maxSourceChars = Math.floor(handoff.maxSourceChars);
		} else {
			problems.push('"maxSourceChars" must be a number >= 0');
		}
	}

	return problems.length > 0
		? { settings, warning: `pi-clear: ignoring ${path} ${problems.join(", ")}` }
		: { settings };
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Command arg > pi CLI flag > config file > built-in default. */
export function resolveMaxSourceChars(flagValue: unknown, settings: HandoffSettings): number {
	if (typeof flagValue === "string" && flagValue.trim()) {
		const fromFlag = Number(flagValue);
		if (Number.isFinite(fromFlag) && fromFlag >= 0) return Math.floor(fromFlag);
	}
	if (settings.maxSourceChars !== undefined) return settings.maxSourceChars;
	return DEFAULT_MAX_SOURCE_CHARS;
}

/** `118234` → `118k`, for the trimming notice. */
function formatChars(chars: number): string {
	if (chars < 1000) return String(chars);
	if (chars < 1_000_000) return `${Math.round(chars / 1000)}k`;
	return `${(chars / 1_000_000).toFixed(1)}M`;
}

type WriterChoice = { kind: "live" } | { kind: "fresh"; model: AnyModel };

interface WriterOptions {
	/** From `--fresh` / `--live`; skips the writer picker. */
	writer?: "live" | "fresh";
	/** Model pinned by command arg, pi flag, or config. */
	pinnedModel?: AnyModel;
	/** Whether the summarizer model picker still needs to open. */
	askSummarizer: boolean;
}

const WRITER_LIVE_LABEL = "This agent — full context and tools";
const WRITER_FRESH_OTHER_LABEL = "Fresh pass — another model…";

/** Pick the hand-off writer: the live agent, or a fresh pass with a chosen model. */
async function chooseWriter(ctx: ExtensionContext, options: WriterOptions): Promise<WriterChoice | undefined> {
	const withCurrentModel = (): WriterChoice | undefined => {
		const model = options.pinnedModel ?? ctx.model;
		if (!model) {
			ctx.ui.notify("No current model to write the hand-off; pick another model", "error");
			return undefined;
		}
		return { kind: "fresh", model };
	};

	const askForModel = async (): Promise<WriterChoice | undefined> => {
		if (!options.askSummarizer) return withCurrentModel();
		const picked = await pickTargetModel(ctx, {
			current: options.pinnedModel ?? ctx.model,
			title: "Hand-off writer model",
			providerTitle: "Hand-off writer provider",
		});
		if (!picked) return undefined;
		if (!ctx.modelRegistry.hasConfiguredAuth(picked.model)) {
			ctx.ui.notify(
				`No auth configured for ${picked.model.provider}/${picked.model.id}; staying in this session`,
				"error",
			);
			return undefined;
		}
		return { kind: "fresh", model: picked.model };
	};

	if (options.writer === "live") return { kind: "live" };
	if (options.writer === "fresh") return askForModel();

	const labels = [
		WRITER_LIVE_LABEL,
		options.pinnedModel
			? `Fresh pass — ${options.pinnedModel.provider}/${options.pinnedModel.id}`
			: "Fresh pass — current model",
		WRITER_FRESH_OTHER_LABEL,
	];
	const chosen = await ctx.ui.select("Who writes the hand-off prompt?", labels);
	if (chosen === undefined) return undefined;

	switch (labelIndex(chosen, labels)) {
		case 0:
			return { kind: "live" };
		case 1:
			return withCurrentModel();
		case 2:
			return askForModel();
		default:
			return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// In-session state for the hand-off capture; fresh per extension instance,
	// so it never leaks into a replacement session.
	let awaitingHandoff = false;
	let capturedPrompt: string | undefined;
	let flowInProgress = false;
	// Config file contents and the resolved transcript budget, refreshed on every
	// `session_start` (the file is read once per session, not per hand-off).
	let handoffSettings: HandoffSettings = {};
	let maxSourceChars = DEFAULT_MAX_SOURCE_CHARS;

	/**
	 * Apply a captured model and thinking level, reporting problems as
	 * warnings. Returns true when the model was applied.
	 */
	async function applyHandoffModel(handoff: SessionHandoff, ctx: ExtensionContext): Promise<boolean> {
		try {
			const model = ctx.modelRegistry.find(handoff.provider, handoff.modelId);
			if (!model) {
				ctx.ui.notify(`pi-clear: model ${handoff.provider}/${handoff.modelId} is no longer available`, "warning");
				return false;
			}

			const applied = await pi.setModel(model);
			if (!applied) {
				ctx.ui.notify(`pi-clear: no auth configured for ${handoff.provider}/${handoff.modelId}`, "warning");
				return false;
			}

			if (handoff.thinkingLevel) {
				await pi.setThinkingLevel(handoff.thinkingLevel);
			}
			return true;
		} catch (err) {
			ctx.ui.notify(
				`pi-clear: could not restore model ${handoff.provider}/${handoff.modelId}: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return false;
		}
	}

	/** Ask the live agent to write its next message as the hand-off prompt. */
	async function captureFromLiveAgent(
		ctx: ExtensionCommandContext,
		steering: string,
	): Promise<string | undefined> {
		awaitingHandoff = true;
		capturedPrompt = undefined;
		try {
			await pi.sendMessage(
				{
					customType: HANDOFF_CUSTOM_TYPE,
					content: buildHandoffRequest(steering),
					display: true,
				},
				{ triggerTurn: true },
			);
			await ctx.waitForIdle();
		} finally {
			awaitingHandoff = false;
		}

		if (!capturedPrompt) {
			ctx.ui.notify("The agent did not produce a hand-off prompt; staying in this session", "error");
			return undefined;
		}
		return capturedPrompt;
	}

	/** One fresh pass over the minimal transcript; notifies when it trims. */
	async function captureFromFreshPass(
		ctx: ExtensionContext,
		writer: WriterChoice & { kind: "fresh" },
		steering: string,
	): Promise<string | undefined> {
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const source = buildMinimalTranscript(messages, maxSourceChars);
		if (!source.text.trim()) {
			ctx.ui.notify("No conversation to hand off", "error");
			return undefined;
		}
		if (source.omittedTurns > 0) {
			ctx.ui.notify(
				`Hand-off source trimmed: ${source.omittedTurns} earlier turns omitted (~${formatChars(source.droppedChars)} chars dropped)`,
				"info",
			);
		}
		return generateFreshPassPrompt(ctx, writer.model, source.text, steering);
	}

	pi.registerFlag(FLAG_MAX_SOURCE_CHARS, {
		description:
			"pi-clear: max characters of conversation sent to the /hand-off writer (0 disables the budget)",
		type: "string",
	});
	pi.registerFlag(FLAG_SUMMARIZER, {
		description: "pi-clear: model that writes /hand-off prompts, as provider/model",
		type: "string",
	});

	pi.registerCommand("clear", {
		description: "Start a fresh session, keeping the current model and thinking level",
		handler: async (_args, ctx) => {
			try {
				if (flowInProgress) {
					ctx.ui.notify("Hand-off in progress; wait for it to finish", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the agent to finish before clearing", "info");
					await ctx.waitForIdle();
				}

				const { model } = ctx;
				if (model) {
					// Capture plain data only: it must survive session replacement.
					writeHandoff({
						provider: model.provider,
						modelId: model.id,
						thinkingLevel: ctx.thinkingLevel,
					});
				}

				const result = await ctx.newSession();
				// Normally session_start already consumed the handoff; clear any
				// leftover so it can never apply to a later, unrelated /new.
				takeHandoff();
				if (result.cancelled) {
					ctx.ui.notify("Clear cancelled by extension", "warning");
				}
			} catch (err) {
				takeHandoff();
				ctx.ui.notify(`Clear failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("hand-off", {
		description:
			"Hand the conversation to another model: choose who writes the hand-off prompt (this agent or a fresh pass), pick the next model and thinking level, then review the prompt in a fresh session",
		handler: async (args, ctx) => {
			if (flowInProgress) {
				ctx.ui.notify("A hand-off is already in progress", "warning");
				return;
			}
			try {
				flowInProgress = true;

				const parsed = parseHandoffArgs(args);
				if (parsed.error) {
					ctx.ui.notify(parsed.error, "error");
					return;
				}

				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the agent to finish before handing off", "info");
					await ctx.waitForIdle();
				}

				// Summarizer model: command arg > pi CLI flag > config file.
				const flagSummarizer = pi.getFlag(FLAG_SUMMARIZER);
				const summarizerSpec =
					parsed.summarizerModel ??
					(typeof flagSummarizer === "string" && flagSummarizer.trim() ? flagSummarizer.trim() : undefined) ??
					handoffSettings.summarizerModel;
				const pinnedModel = summarizerSpec
					? ctx.modelRegistry.find(
							summarizerSpec.slice(0, summarizerSpec.indexOf("/")),
							summarizerSpec.slice(summarizerSpec.indexOf("/") + 1),
						)
					: undefined;
				if (summarizerSpec && !pinnedModel) {
					ctx.ui.notify(
						`Hand-off writer model ${summarizerSpec} is not available; choose one instead`,
						"warning",
					);
				}
				// An explicit choice (command arg or pi flag) is not asked again; a
				// config-file model is only silently accepted when
				// `askSummarizerModel` is false.
				const pinnedExplicitly =
					parsed.summarizerModel !== undefined || typeof flagSummarizer === "string";
				const askSummarizer =
					!pinnedModel || (!pinnedExplicitly && handoffSettings.askSummarizerModel !== false);

				// 1. Choose who writes the hand-off prompt.
				const writer = await chooseWriter(ctx, {
					writer: parsed.writer,
					pinnedModel,
					askSummarizer,
				});
				if (!writer) return;

				// 2. Pick the destination model.
				const target = await pickTargetModel(ctx);
				if (!target) return;

				// 3. Pick the thinking level (a scoped `model:level` entry pins it).
				const level = target.thinkingLevel ?? (await selectThinkingLevel(ctx));
				if (level === undefined) return;

				// 4. Collect steering instructions, pre-filled from the remaining args.
				const steering = await ctx.ui.editor(
					writer.kind === "live"
						? "Steering for the hand-off prompt (sent to the current agent)"
						: "Steering for the hand-off prompt (sent to the hand-off writer)",
					parsed.steering.trim(),
				);
				if (steering === undefined) return;

				// 5. Write the hand-off prompt with the chosen writer.
				const prompt =
					writer.kind === "live"
						? await captureFromLiveAgent(ctx, steering)
						: await captureFromFreshPass(ctx, writer, steering);
				if (!prompt) return;

				// 6. Carry everything across session replacement as plain data, with
				// the provenance comment added here (never by the writer model).
				writeHandoff({
					provider: target.model.provider,
					modelId: target.model.id,
					thinkingLevel: level,
					prompt: withSessionProvenance(prompt, ctx),
				});

				const result = await ctx.newSession();
				// Normally session_start already consumed the handoff; clear any
				// leftover so it can never apply to a later, unrelated /new.
				takeHandoff();
				if (result.cancelled) {
					ctx.ui.notify("Hand-off cancelled by extension", "warning");
				}
			} catch (err) {
				takeHandoff();
				awaitingHandoff = false;
				ctx.ui.notify(`Hand-off failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				flowInProgress = false;
			}
		},
	});

	pi.on("agent_end", (event) => {
		if (!awaitingHandoff) return;
		awaitingHandoff = false;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				// Only accept a cleanly finished message: agent_end also fires on
				// abort and error, where the text is partial or absent.
				if ((message as { stopReason?: string }).stopReason !== "stop") break;
				const text = messageText(message as { role: string; content: string | Array<{ type: string; text?: string }> });
				if (text.trim()) capturedPrompt = text.trim();
				break;
			}
		}
	});

	pi.on("session_start", async (event, ctx) => {
		const loaded = loadHandoffSettings();
		handoffSettings = loaded.settings;
		maxSourceChars = resolveMaxSourceChars(pi.getFlag(FLAG_MAX_SOURCE_CHARS), loaded.settings);
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");

		if (event.reason !== "new") return;

		const handoff = takeHandoff();
		if (!handoff) return;

		await applyHandoffModel(handoff, ctx);

		if (handoff.prompt) {
			try {
				ctx.ui.setEditorText(handoff.prompt);
			} catch (err) {
				ctx.ui.notify(
					`pi-clear: could not insert the hand-off prompt into the editor: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}
	});
}
