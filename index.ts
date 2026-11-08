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
 * `/hand-off`: hand the conversation to another model (or back to the same
 * one, with `--same`).
 *
 * 1. The user runs `/hand-off`, optionally with `--fresh` or `--live` and
 *    steering text after them.
 * 2. A dialog flow asks who writes the hand-off prompt, then asks whether the
 *    next session keeps the current model and thinking level (first option,
 *    so Enter keeps them) or opens the destination pickers — `--same` skips
 *    that dialog and re-uses the current values. Then steering instructions:
 *    text typed inline after `/hand-off` is used as-is, and an editor opens
 *    only when no inline steering was passed.
 * 3. The hand-off prompt is written by one of two writers:
 *    - the **live agent** (default, first in the picker): the extension sends
 *      the current agent a custom message asking it to write its next message
 *      as the hand-off prompt, and `agent_end` captures the final assistant
 *      message. It sees the whole transcript and keeps tool access.
 *    - the **fresh pass**: a single out-of-band `modelRegistry.complete()`
 *      call over a *minimal reconstruction* of the conversation (no tool
 *      output, no thinking, head+tail budget), so long or stale sessions can
 *      still be handed off, and a cheap model can do the writing. It has no
 *      tool access, and its thinking level is chosen separately (provider
 *      default preselected).
 * 4. The extension prepends a provenance comment naming the source session
 *    (both writers), replaces the session, applies the chosen model and
 *    thinking level, and inserts the prompt into the editor.
 * 5. The user reviews, edits, and submits the prompt themselves.
 *
 * `/hand-off-chain N [--max-cost USD] [task]`: opt-in autonomous chain. Arms a run of up to
 * N hand-offs: the current agent is step 0 and not counted, so up to N+1 sessions. Each agent ends its work with a final
 * message that is exactly one `<hand-off>…</hand-off>` block; on
 * `agent_settled` the extension extracts it and replaces the session through
 * an internal command (event contexts cannot), keeping the same model and
 * thinking level, and submits the block plus a provenance header and the
 * chain protocol as the next agent's first message. The chain state lives on
 * `globalThis` for the whole run. An agent may instead end with
 * `<hand-off done/>`, `<hand-off stop>reason</hand-off>`, or
 * `<hand-off pause>question</hand-off>` (the chain stays armed on that session and
 * resumes at its next settle, once the user has replied). A missing or
 * malformed tag gets one reminder message, then the chain stops. It also stops,
 * with a notification (including total spent), on: abort, a non-clean stop,
 * the step limit, `--max-cost` (escalating steering warnings at 80/95/98% of
 * the limit after tool turns, a hard abort at 100%, and no new session at
 * 95%+), or a watchdog if the internal advance command never starts.
 * The decision logic is the pure `decideChainAction`. Arming refuses while a
 * chain runs in this session and replaces one waiting on another session.
 * Tags in code fences never count. Each hop appends a
 * `pi-clear:chain-hop` session entry (step, model, tokens, cost), and every
 * stop appends a `pi-clear:chain-stop` entry (step, reason, spent).
 * `/hand-off-chain off` disarms; bare or `status` reports.
 *
 * Settings live in `<agent-dir>/pi-clear.json` (read once per
 * `session_start`); CLI flags `--hand-off-max-source-chars` and
 * `--hand-off-summarizer` override the file. Without a configured writer
 * model, `/hand-off` just asks: there is no command-arg model flag.
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

/**
 * Reasoning levels offered for the fresh pass. "off" is not offered: it means
 * the same thing as the provider default here, because the option is omitted
 * either way.
 */
const WRITER_REASONING_LEVELS: ThinkingLevel[] = THINKING_LEVELS.filter((level) => level !== "off");
const WRITER_DEFAULT_REASONING_LABEL = "provider default";

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
 * Same-or-pick picker between the writer and destination dialogs. The first
 * option re-uses the current session's model and thinking level in one Enter
 * press; the second opens the destination pickers. Without a current model
 * there is nothing to re-use, so the destination pickers open directly.
 */
async function chooseSameOrPick(ctx: ExtensionContext): Promise<"same" | "pick" | undefined> {
	if (!ctx.model) return "pick";
	const labels = [
		`${SAME_SETTINGS_LABEL}  (${ctx.model.provider}/${ctx.model.id}${ctx.thinkingLevel ? ` · ${ctx.thinkingLevel}` : ""})`,
		PICK_SETTINGS_LABEL,
	];
	const chosen = await ctx.ui.select("Model for the next session", labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === 0 ? "same" : index === 1 ? "pick" : undefined;
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
 * Thinking level for the fresh pass writer. The provider default comes first and
 * is preselected unless the config file pins a level, so pressing Enter keeps
 * today's behavior and the dialog is a no-op for most runs.
 */
async function selectWriterReasoningLevel(
	ctx: ExtensionContext,
	preselected: ThinkingLevel | undefined,
): Promise<{ reasoning?: ThinkingLevel } | undefined> {
	const ordered = preselected
		? [preselected, ...WRITER_REASONING_LEVELS.filter((level) => level !== preselected)]
		: [...WRITER_REASONING_LEVELS];
	const options: Array<{ reasoning?: ThinkingLevel; label: string }> = ordered.map((level) => ({
		reasoning: level,
		label: `${level}${level === preselected ? "  (current)" : ""}`,
	}));
	if (preselected) {
		options.push({ label: WRITER_DEFAULT_REASONING_LABEL });
	} else {
		options.unshift({ label: `${WRITER_DEFAULT_REASONING_LABEL}  (current)` });
	}

	const labels = options.map((option) => option.label);
	const chosen = await ctx.ui.select("Thinking level for the hand-off writer", labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === -1 ? undefined : { reasoning: options[index].reasoning };
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

/** Options for the one-shot writer call; `reasoning` is only set when supported. */
interface WriterRequestOptions {
	signal?: AbortSignal;
	cacheRetention: "none";
	sessionId: string;
	reasoning?: ThinkingLevel;
}

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
	reasoning: ThinkingLevel | undefined,
): Promise<string | undefined> {
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: buildFreshPassUserMessage(transcript, steering) }],
		timestamp: Date.now(),
	};

	const attempt = async (signal?: AbortSignal): Promise<WriterOutcome> => {
		const options: WriterRequestOptions = { signal, cacheRetention: "none", sessionId: randomUUID() };
		// Providers default when the option is absent, and models without
		// reasoning controls would reject it; pi's own summarization does the
		// same check before setting the level.
		if (reasoning && model.reasoning) options.reasoning = reasoning;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
				options,
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
	/** `--same`: skip the destination pickers and reuse the current session's model and thinking level. */
	same?: boolean;
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
		if (token === "--same") {
			parsed.same = true;
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
	/** Thinking level for the fresh pass; absent means the provider default. */
	summarizerThinkingLevel?: ThinkingLevel;
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
	if (handoff.summarizerThinkingLevel !== undefined) {
		const value = handoff.summarizerThinkingLevel;
		// "default" (and "off") mean "leave the choice to the provider", the same
		// as omitting the key.
		if (value === "default" || value === "off") {
			// Nothing to record.
		} else if (typeof value === "string" && WRITER_REASONING_LEVELS.includes(value as ThinkingLevel)) {
			settings.summarizerThinkingLevel = value as ThinkingLevel;
		} else {
			problems.push(
				`"summarizerThinkingLevel" must be "default" or one of ${WRITER_REASONING_LEVELS.join(", ")}`,
			);
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
const SAME_SETTINGS_LABEL = "Same model and thinking level";
const PICK_SETTINGS_LABEL = "Pick a model and thinking level…";

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

// ============================================================================
// Autonomous chain (`/hand-off-chain N`)
// ============================================================================

/**
 * Chain state, kept on `globalThis` for the whole run (unlike `SessionHandoff`
 * it is not consumed) so the depth counter survives session replacement.
 */
interface ChainState {
	/** Maximum number of hand-offs; the agent that armed the chain is step 0 and not counted. */
	maxSteps: number;
	/**
	 * Session IDs in the order they ran, latest last. The last one is the
	 * session the chain is waiting on (other sessions never advance it), and
	 * the length minus one is the current step.
	 */
	sessionIds: string[];
	/** Stop before the next hand-off once spent cost reaches this many dollars. */
	maxCost?: number;
	/** Cost of the sessions already left; the current session's cost is added on top. */
	spent: number;
	/** The agent asked the user a question and the chain is waiting for them (cleared on the next settle). */
	paused?: boolean;
	/** Highest budget warning level already sent in the current session (0 = none). */
	warned?: number;
	/** The current session was already asked once to fix a missing/malformed final message. */
	nudged?: boolean;
	/**
	 * A hand-off extracted from the settled agent, waiting for the step command.
	 * `started` flips once that command runs, so a watchdog can tell "never ran".
	 */
	pending?: { prompt: string; started?: boolean };
}

const CHAIN_KEY = "__pi_clear_chain__";
const CHAIN_COMMAND = "pi-clear-chain-advance";
/** How long the internal advance command has to start before the chain gives up. */
const ADVANCE_WATCHDOG_MS = 10_000;
const CHAIN_PROTOCOL_TYPE = "pi-clear:chain-protocol";
const CHAIN_HOP_ENTRY_TYPE = "pi-clear:chain-hop";
const CHAIN_STOP_ENTRY_TYPE = "pi-clear:chain-stop";

function readChain(): ChainState | undefined {
	return (globalThis as Record<string, unknown>)[CHAIN_KEY] as ChainState | undefined;
}

/** 0-based position of the current agent: the one that armed the chain is step 0. */
function chainStep(chain: ChainState): number {
	return chain.sessionIds.length - 1;
}

function writeChain(chain: ChainState | undefined): void {
	const store = globalThis as Record<string, unknown>;
	if (chain) store[CHAIN_KEY] = chain;
	else delete store[CHAIN_KEY];
}

export type ChainArgs =
	| { kind: "start"; maxSteps: number; maxCost?: number; task: string }
	| { kind: "off" }
	| { kind: "status" }
	| { kind: "error"; error: string };

const CHAIN_USAGE = "/hand-off-chain needs a positive number of hand-offs, or `off` / `status`";

/**
 * Parse `<N|off|status> [--max-cost USD] [task text]`; no arguments means
 * `status`. Like `/hand-off`, flags are only recognized before the task.
 */
export function parseChainArgs(args: string): ChainArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const value = tokens[0];
	if (value === undefined || value === "status") return { kind: "status" };
	if (value === "off") return { kind: "off" };
	if (!/^\d+$/.test(value) || Number(value) < 1) return { kind: "error", error: CHAIN_USAGE };

	let maxCost: number | undefined;
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i];
		let raw: string | undefined;
		if (token === "--max-cost") {
			raw = tokens[i + 1];
			i += 2;
		} else if (token.startsWith("--max-cost=")) {
			raw = token.slice("--max-cost=".length);
			i += 1;
		} else break;
		const amount = raw !== undefined && /^\$?\d+(\.\d+)?$/.test(raw) ? Number(raw.replace("$", "")) : NaN;
		if (!(amount > 0)) return { kind: "error", error: "--max-cost needs a positive dollar amount, e.g. --max-cost 5" };
		maxCost = amount;
	}
	return { kind: "start", maxSteps: Number(value), maxCost, task: tokens.slice(i).join(" ") };
}

export type ChainSignal =
	| { kind: "hand-off"; body: string }
	| { kind: "done" }
	| { kind: "stop"; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "none" }
	| { kind: "invalid"; reason: string };

/** Replace fenced code blocks with a blank so quoted syntax never counts as a tag. */
function stripCodeFences(text: string): string {
	return text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*|$)/gm, "");
}

/**
 * Classify a final assistant message. A hand-off only counts when the tag
 * wraps the *whole* message, outside code fences; a tag anywhere else is
 * `invalid` (the chain stops) rather than ignored, so a half-formed hand-off
 * never silently ends the chain as "done".
 */
export function parseChainSignal(text: string): ChainSignal {
	const trimmed = text.trim();
	if (/^<hand-off\s+done\s*\/>$/.test(trimmed)) return { kind: "done" };
	const whole = /^<hand-off(?:\s+(stop|pause))?>([\s\S]*)<\/hand-off>$/.exec(trimmed);
	if (whole) {
		const word = whole[1] as "stop" | "pause" | undefined;
		const body = whole[2].trim();
		if (!body) return { kind: "invalid", reason: `the hand-off ${word ? `${word} reason` : "block"} is empty` };
		// A literal tag inside the body (hand-offs often explain the syntax) is just text.
		return word ? { kind: word, reason: body } : { kind: "hand-off", body };
	}
	if (/<hand-off(\s[^>]*)?\/?>|<\/hand-off>/.test(stripCodeFences(trimmed))) {
		return { kind: "invalid", reason: "a hand-off tag appears, but does not wrap the whole final message" };
	}
	return { kind: "none" };
}

interface UsageTotals {
	input: number;
	output: number;
	total: number;
	cost: number;
}

/** Sum token usage and cost over the assistant messages of a transcript. */
export function sumUsage(messages: ReadonlyArray<{ role: string; usage?: unknown }>): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, total: 0, cost: 0 };
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
		const usage = message.usage as {
			input?: number;
			output?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

/** The three ways a chained agent may end, as shown to it. */
function signalInstructions(step: number, maxSteps: number): string[] {
	const last = step >= maxSteps;
	return [
		"End with exactly one of these as your **entire** final message (nothing before or after, no code fence):",
		...(last
			? ["- This is the last step the chain allows (no more hand-offs), so a `<hand-off>` will be refused."]
			: ["- `<hand-off>…</hand-off>`: what you did, what is next, and any gotchas."]),
		"- `<hand-off done/>`: the work is complete.",
		"- `<hand-off pause>question</hand-off>`: you need an answer from the user. The chain waits in this session and continues when you next finish, after they reply.",
		"- `<hand-off stop>reason</hand-off>`: you cannot continue (blocked, failing). The chain ends and the user sees your reason.",
	];
}

/** Instructions appended to every chained prompt, and sent to the first agent when the chain is armed. */
export function buildChainProtocol(step: number, maxSteps: number): string {
	return [
		`## Autonomous chain: step ${step} of ${maxSteps}`,
		"",
		"You are one step in a chain of agents; when you finish, a fresh agent continues from your hand-off. Nobody is watching live.",
		"",
		...signalInstructions(step, maxSteps),
	].join("\n");
}

/** Follow-up sent once when a final message has no usable tag. */
export function buildChainNudge(step: number, maxSteps: number, problem: string): string {
	return [
		`Your last message can't advance the chain: ${problem}.`,
		"",
		...signalInstructions(step, maxSteps),
	].join("\n");
}

/**
 * Escalating budget warnings, as fractions of `--max-cost`. At the last level
 * and beyond (up to 100%) the agent is told to write its final status; at
 * 100% the session is aborted.
 */
const BUDGET_LEVELS = [
	{
		at: 0.8,
		text: (pct: string, spent: string, max: string) =>
			`Budget heads-up: this chain has used ${pct}% of its $${max} cost limit ($${spent}). Plan to wrap up soon.`,
	},
	{
		at: 0.95,
		text: (pct: string, spent: string, max: string) =>
			`Budget warning: ${pct}% of the $${max} cost limit is used ($${spent}). Stop now: finish only your final tasks and leave the work in a consistent state. Do not start anything new.`,
	},
	{
		at: 0.98,
		text: (pct: string, spent: string, max: string) =>
			`Out of budget (${pct}% of $${max}, $${spent}). Your next message must be your last: end with \`<hand-off stop>…</hand-off>\` summarizing the current status (what is done, what is not, where things stand).`,
	},
] as const;

/** At or past this fraction of the limit, the chain does not start another session. */
const NO_NEW_SESSION_AT = BUDGET_LEVELS[1].at;

export type BudgetAction =
	| { kind: "none" }
	| { kind: "warn"; level: number; message: string }
	| { kind: "abort"; reason: string };

/**
 * What to do about cost while the current session runs. Returns only the
 * highest level newly crossed, so each level is sent once and a jump over
 * several levels sends one message. `level` is 1-based, for `ChainState.warned`.
 */
export function decideBudgetAction(
	chain: Pick<ChainState, "maxCost" | "spent" | "warned">,
	sessionCost: number,
): BudgetAction {
	const max = chain.maxCost;
	if (max === undefined) return { kind: "none" };
	const spent = chain.spent + sessionCost;
	if (spent >= max) {
		return { kind: "abort", reason: `cost limit reached mid-step ($${spent.toFixed(2)} of $${max.toFixed(2)})` };
	}
	const crossed = BUDGET_LEVELS.reduce((n, level, i) => (spent >= level.at * max ? i + 1 : n), 0);
	if (crossed <= (chain.warned ?? 0)) return { kind: "none" };
	const pct = Math.floor((spent / max) * 100).toString();
	return { kind: "warn", level: crossed, message: BUDGET_LEVELS[crossed - 1].text(pct, spent.toFixed(2), max.toFixed(2)) };
}

export interface ChainDecisionInput {
	chain: Pick<ChainState, "maxSteps" | "sessionIds" | "maxCost" | "spent" | "nudged" | "pending">;
	/** The session whose agent just settled. */
	sessionId: string;
	aborted: boolean;
	/** The last assistant message, if any. */
	last: { stopReason?: string; text: string } | undefined;
	/** Cost of the settled session alone. */
	sessionCost: number;
}

export type ChainDecision =
	| { kind: "ignore" }
	| { kind: "stop"; reason: string; level: "info" | "warning" | "error" }
	| { kind: "pause"; reason: string }
	| { kind: "nudge"; problem: string }
	| { kind: "hop"; body: string; step: number; spent: number };

/** What the chain should do now that an agent settled. Pure: no I/O, no ctx. */
export function decideChainAction(input: ChainDecisionInput): ChainDecision {
	const { chain, last } = input;
	if (chain.pending) return { kind: "ignore" };
	// Ignore sessions the chain is not waiting on (a manual /new, say).
	if (chain.sessionIds.at(-1) !== input.sessionId) return { kind: "ignore" };
	if (input.aborted) return { kind: "stop", reason: "the run was aborted", level: "warning" };
	if (!last) return { kind: "stop", reason: "no assistant message to read", level: "error" };
	if (last.stopReason !== "stop") {
		return { kind: "stop", reason: `the final message ended with "${last.stopReason ?? "unknown"}"`, level: "error" };
	}

	const signal = parseChainSignal(last.text);
	if (signal.kind === "done") return { kind: "stop", reason: "the agent signalled the work is done", level: "info" };
	if (signal.kind === "stop") return { kind: "stop", reason: `the agent stopped it: ${signal.reason}`, level: "warning" };
	if (signal.kind === "pause") return { kind: "pause", reason: signal.reason };

	const step = chain.sessionIds.length - 1;
	const spent = chain.spent + input.sessionCost;
	if (chain.maxCost !== undefined && spent >= chain.maxCost * NO_NEW_SESSION_AT) {
		return {
			kind: "stop",
			reason: `spent $${spent.toFixed(2)} of the $${chain.maxCost.toFixed(2)} limit, too little left to start another session`,
			level: "warning",
		};
	}
	if (signal.kind === "none" || signal.kind === "invalid") {
		const problem = signal.kind === "none" ? "it has no <hand-off> tag" : signal.reason;
		if (chain.nudged) return { kind: "stop", reason: `${problem} (after one reminder)`, level: "warning" };
		return { kind: "nudge", problem };
	}
	if (step >= chain.maxSteps) {
		return { kind: "stop", reason: `reached the limit of ${chain.maxSteps} hand-offs; the agent asked for another hand-off`, level: "warning" };
	}
	return { kind: "hop", body: signal.body, step, spent };
}

/** Provenance header, hand-off body, and protocol for the next agent. */
export function buildChainPrompt(
	body: string,
	opts: { step: number; maxSteps: number; fromSessionId: string | undefined },
): string {
	const from = opts.fromSessionId?.trim();
	const header = `<!-- pi-clear chain: step ${opts.step} of ${opts.maxSteps}${from ? ` · handed off from pi session ${from}` : ""} -->`;
	return `${header}\n\n${body}\n\n---\n\n${buildChainProtocol(opts.step, opts.maxSteps)}`;
}

export default function (pi: ExtensionAPI) {
	// In-session state for the hand-off capture; fresh per extension instance,
	// so it never leaks into a replacement session.
	let awaitingHandoff = false;
	let capturedPrompt: string | undefined;
	let flowInProgress = false;
	// Config file contents, refreshed on every `session_start` (the file is read
	// once per session, not per hand-off). The pi CLI flag is read per hand-off
	// so it works even if a command somehow runs before `session_start`.
	let handoffSettings: HandoffSettings = {};

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
		reasoning: ThinkingLevel | undefined,
		steering: string,
	): Promise<string | undefined> {
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const maxSourceChars = resolveMaxSourceChars(pi.getFlag(FLAG_MAX_SOURCE_CHARS), handoffSettings);
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
		return generateFreshPassPrompt(ctx, writer.model, source.text, steering, reasoning);
	}

	/** Cost of the current session, 0 if it cannot be read (a replaced session's context). */
	function sessionCost(ctx: ExtensionContext): number {
		try {
			return sumUsage(ctx.sessionManager.buildSessionProjection().messages).cost;
		} catch {
			return 0;
		}
	}

	/** Ends the chain and tells the user why, with the total spent. */
	function stopChain(ctx: ExtensionContext, reason: string, level: "info" | "warning" | "error"): void {
		const chain = readChain();
		writeChain(undefined);
		let where = "";
		if (chain) {
			// While a hand-off is pending, `spent` already includes this session.
			const spent = chain.pending ? chain.spent : chain.spent + sessionCost(ctx);
			where = ` (step ${chainStep(chain)} of ${chain.maxSteps}, $${spent.toFixed(2)} spent)`;
		}
		if (chain) {
			// Leave a record in the transcript; the notification alone is not persisted.
			try {
				pi.appendEntry(CHAIN_STOP_ENTRY_TYPE, {
					step: chainStep(chain),
					maxSteps: chain.maxSteps,
					reason,
					level,
					spent: chain.pending ? chain.spent : chain.spent + sessionCost(ctx),
					at: new Date().toISOString(),
				});
			} catch {
				// The session may already be replaced; the notification still goes out.
			}
		}
		ctx.ui.notify(`Hand-off chain stopped${where}: ${reason}`, level);
	}

	/** Stops the chain if the internal advance command never started (it was not dispatched). */
	function watchAdvance(ctx: ExtensionContext, pending: object): void {
		setTimeout(() => {
			const chain = readChain();
			if (chain?.pending !== pending || chain.pending.started) return;
			stopChain(ctx, "the hand-off did not start (the internal advance command never ran)", "error");
		}, ADVANCE_WATCHDOG_MS).unref?.();
	}

	pi.on("agent_settled", async (event, ctx) => {
		const chain = readChain();
		if (!chain) return;

		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const lastMessage = [...messages].reverse().find((m) => m.role === "assistant") as
			| { role: string; stopReason?: string; content: string | Array<{ type: string; text?: string }> }
			| undefined;
		const totals = sumUsage(messages);
		const decision = decideChainAction({
			chain,
			sessionId: ctx.sessionManager.getSessionId(),
			aborted: Boolean(event.aborted),
			last: lastMessage && { stopReason: lastMessage.stopReason, text: messageText(lastMessage) },
			sessionCost: totals.cost,
		});

		if (decision.kind === "ignore") return;
		if (decision.kind === "stop") return stopChain(ctx, decision.reason, decision.level);
		if (decision.kind === "pause") {
			// The chain stays armed on this session; the next settle re-evaluates it.
			writeChain({ ...chain, paused: true, nudged: false });
			ctx.ui.notify(
				`Hand-off chain paused at step ${chainStep(chain)} of ${chain.maxSteps}: ${decision.reason}\nReply in this session and the chain continues when the agent finishes. \`/hand-off-chain off\` cancels it.`,
				"warning",
			);
			return;
		}
		if (chain.paused) writeChain({ ...chain, paused: false });
		if (decision.kind === "nudge") {
			writeChain({ ...chain, paused: false, nudged: true });
			const step = chainStep(chain);
			pi.sendUserMessage(buildChainNudge(step, chain.maxSteps, decision.problem));
			return;
		}

		const model = ctx.model;
		if (!model) return stopChain(ctx, "no model to carry over", "error");

		const { step, spent } = decision;
		const fromSessionId = ctx.sessionManager.getSessionId();
		pi.appendEntry(CHAIN_HOP_ENTRY_TYPE, {
			step,
			maxSteps: chain.maxSteps,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: ctx.thinkingLevel,
			tokens: { input: totals.input, output: totals.output, total: totals.total },
			cost: totals.cost,
			at: new Date().toISOString(),
		});

		const pending = {
			prompt: buildChainPrompt(decision.body, { step: step + 1, maxSteps: chain.maxSteps, fromSessionId }),
		};
		writeChain({ ...chain, spent, nudged: false, pending });
		writeHandoff({ provider: model.provider, modelId: model.id, thinkingLevel: ctx.thinkingLevel });
		// Event contexts cannot replace the session; a command context can, so
		// hand the work to the internal command (processed after settled handlers).
		pi.sendUserMessage(`/${CHAIN_COMMAND}`, { expandPromptTemplates: true });
		watchAdvance(ctx, pending);
	});

	// Cost guard while a step runs: escalating steering messages, then a hard abort.
	pi.on("turn_end", async (event, ctx) => {
		const chain = readChain();
		if (!chain || chain.maxCost === undefined || chain.pending) return;
		if (chain.sessionIds.at(-1) !== ctx.sessionManager.getSessionId()) return;

		const action = decideBudgetAction(chain, sessionCost(ctx));
		if (action.kind === "abort") {
			stopChain(ctx, `${action.reason}; aborted session ${ctx.sessionManager.getSessionId()}`, "warning");
			ctx.abort();
			return;
		}
		// With no tool results the agent is about to finish; a steer would only buy an extra request.
		if (action.kind === "warn" && event.toolResults.length > 0) {
			writeChain({ ...chain, warned: action.level });
			pi.sendUserMessage(action.message, { deliverAs: "steer" });
		}
	});

	pi.registerCommand(CHAIN_COMMAND, {
		description: "Internal: advance an autonomous hand-off chain (not for manual use)",
		handler: async (_args, ctx) => {
			const chain = readChain();
			const pending = chain?.pending;
			if (!chain || !pending) {
				ctx.ui.notify("No autonomous hand-off chain is waiting to advance", "warning");
				return;
			}
			pending.started = true;
			try {
				const result = await ctx.newSession({
					withSession: async (next) => {
						// Retarget the chain at the new session before the first prompt runs.
						const nextId = next.sessionManager.getSessionId();
						if (chain.sessionIds.includes(nextId)) {
							stopChain(next, `session ${nextId} is already in the chain`, "error");
							return;
						}
						writeChain({
							maxSteps: chain.maxSteps,
							maxCost: chain.maxCost,
							spent: chain.spent,
							sessionIds: [...chain.sessionIds, nextId],
						});
						// Do not await: the call may resolve only when the whole run ends.
						next.sendUserMessage(pending.prompt).catch((err: unknown) => {
							stopChain(next, `could not send the hand-off prompt: ${messageOf(err)}`, "error");
						});
					},
				});
				takeHandoff();
				if (result.cancelled) stopChain(ctx, "session replacement was cancelled", "warning");
			} catch (err) {
				takeHandoff();
				stopChain(ctx, `hand-off failed: ${messageOf(err)}`, "error");
			}
		},
	});

	/** Handles `/hand-off-chain \u2026`. */
	async function handleChainCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseChainArgs(args);
		if (parsed.kind === "error") return ctx.ui.notify(parsed.error, "error");
		const chain = readChain();
		const sessionId = ctx.sessionManager.getSessionId();
		if (parsed.kind === "status") {
			if (!chain) return ctx.ui.notify("No hand-off chain is active", "info");
			const lines = [
				`Hand-off chain ${chain.paused ? "paused" : "active"}: step ${chainStep(chain)} of ${chain.maxSteps}, $${chain.spent.toFixed(2)} spent before this session${chain.maxCost !== undefined ? ` (limit $${chain.maxCost.toFixed(2)})` : ""}`,
			];
			if (chain.sessionIds.length > 1) lines.push(`Sessions: ${chain.sessionIds.join(" \u2192 ")}`);
			if (chain.sessionIds.at(-1) !== sessionId) {
				lines.push(`Waiting on session ${chain.sessionIds.at(-1)}, not this one. \`/hand-off-chain off\` clears it.`);
			}
			return ctx.ui.notify(lines.join("\n"), "info");
		}
		if (parsed.kind === "off") {
			writeChain(undefined);
			ctx.ui.notify("Hand-off chain disarmed", "info");
			return;
		}
		if (flowInProgress) return ctx.ui.notify("A hand-off is already in progress", "warning");
		if (!ctx.model) return ctx.ui.notify("/hand-off-chain: the current session has no model to carry over", "error");
		if (chain?.sessionIds.at(-1) === sessionId) {
			const how = chain.paused ? "paused, waiting for your reply" : "already running";
			return ctx.ui.notify(`A chain is ${how} in this session. \`/hand-off-chain off\` stops it first.`, "warning");
		}
		if (!ctx.isIdle()) await ctx.waitForIdle();

		// A chain waiting on some other session is stale (its session was left
		// by hand); this process can only run one chain, so replace it.
		writeChain({ maxSteps: parsed.maxSteps, maxCost: parsed.maxCost, spent: 0, sessionIds: [sessionId] });
		const stale = chain ? " Replaced a stale chain." : "";
		ctx.ui.notify(
			`Hand-off chain armed: up to ${parsed.maxSteps} hand-offs${parsed.maxCost !== undefined ? `, $${parsed.maxCost.toFixed(2)} limit` : ", no cost limit"}, same model each hop.${stale} Agents run unattended with your full tool access. \`/hand-off-chain off\` stops it.`,
			"info",
		);
		const protocol = buildChainProtocol(0, parsed.maxSteps);
		if (parsed.task) {
			await pi.sendUserMessage(`${parsed.task}\n\n---\n\n${protocol}`);
		} else {
			await pi.sendMessage(
				{ customType: CHAIN_PROTOCOL_TYPE, content: protocol, display: true },
				{ triggerTurn: false },
			);
		}
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

	pi.registerCommand("hand-off-chain", {
		description:
			"Autonomous hand-off chain: /hand-off-chain <N> [task] lets agents hand off to each other for up to N hand-offs (the first agent is step 0); `off` disarms, `status` reports",
		handler: async (args, ctx) => handleChainCommand(args, ctx),
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

				// Writer model: pi CLI flag > config file. There is no command-arg
				// flag; without a configured preference the picker just opens.
				const flagSummarizer = pi.getFlag(FLAG_SUMMARIZER);
				const summarizerSpec =
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
				// A pi CLI flag is not asked about again; a config-file model is only
				// silently accepted when `askSummarizerModel` is false.
				const pinnedByFlag = typeof flagSummarizer === "string";
				const askSummarizer =
					!pinnedModel || (!pinnedByFlag && handoffSettings.askSummarizerModel !== false);

				// 1. Choose who writes the hand-off prompt, and (for the fresh pass)
				// how hard that model should think.
				const writer = await chooseWriter(ctx, {
					writer: parsed.writer,
					pinnedModel,
					askSummarizer,
				});
				if (!writer) return;

				let writerReasoning: ThinkingLevel | undefined;
				if (writer.kind === "fresh" && writer.model.reasoning) {
					const chosen = await selectWriterReasoningLevel(ctx, handoffSettings.summarizerThinkingLevel);
					if (!chosen) return;
					writerReasoning = chosen.reasoning;
				}

				// 2–3. Destination model and thinking level. The same-or-pick picker's
				// first option re-uses the current session's values in one Enter press;
				// `--same` skips that dialog. On the picked-model path a scoped
				// `model:level` entry pins the level.
				const reuse = parsed.same ? "same" : await chooseSameOrPick(ctx);
				if (!reuse) return;
				let target: PickedModel | undefined;
				let level: ThinkingLevel | undefined;
				if (reuse === "same") {
					if (!ctx.model) {
						ctx.ui.notify("--same: the current session has no model to reuse", "error");
						return;
					}
					target = { model: ctx.model };
					level = ctx.thinkingLevel;
				} else {
					target = await pickTargetModel(ctx);
					if (!target) return;
					level = target.thinkingLevel ?? (await selectThinkingLevel(ctx));
					if (level === undefined) return;
				}

				// 4. Steering instructions: when passed inline as `/hand-off <instructions>`
				// they are used as-is; only an empty steering text opens the editor.
				const inlineSteering = parsed.steering.trim();
				const steering =
					inlineSteering ||
					(await ctx.ui.editor(
						writer.kind === "live"
							? "Steering for the hand-off prompt (sent to the current agent)"
							: "Steering for the hand-off prompt (sent to the hand-off writer)",
						"",
					));
				if (steering === undefined) return;

				// 5. Write the hand-off prompt with the chosen writer.
				const prompt =
					writer.kind === "live"
						? await captureFromLiveAgent(ctx, steering)
						: await captureFromFreshPass(ctx, writer, writerReasoning, steering);
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
