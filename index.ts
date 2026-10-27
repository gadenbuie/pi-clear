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
 * 1. The user runs `/hand-off` (optionally with steering text after it).
 * 2. A dialog flow collects the destination model and thinking level, then
 *    opens an editor pre-filled with the steering text.
 * 3. The extension sends the current agent a custom message asking it to
 *    write its next message as a hand-off prompt for the next model — no
 *    preamble, no postamble.
 * 4. When the run ends, the final assistant message is captured, the session
 *    is replaced, the chosen model and thinking level are applied, and the
 *    hand-off prompt is inserted into the editor.
 * 5. The user reviews, edits, and submits the prompt themselves.
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

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
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
async function pickTargetModelFallback(ctx: ExtensionContext): Promise<PickedModel | undefined> {
	const current = ctx.model;
	const scoped = ctx.scopedModels.map((scoped) => scoped.model);

	if (scoped.length > 0) {
		// Keep the current model selectable and preselected even when scoping
		// excludes it.
		const models = current && !scoped.some((m) => sameModel(m, current)) ? [current, ...scoped] : scoped;
		const model = await selectModel(ctx, models, "Hand off to model", current);
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
		providers.length === 1 ? providerLabels[0] : await ctx.ui.select("Hand off to provider", providerLabels);
	if (providerChoice === undefined) return undefined;
	const providerIndex = labelIndex(providerChoice, providerLabels);
	if (providerIndex === -1) return undefined;
	const providerName = providers[providerIndex];

	const model = await selectModel(ctx, byProvider.get(providerName) ?? [], "Hand off to model", current);
	return model ? { model } : undefined;
}

/**
 * `/model`-style model picker (TUI mode only): a searchable list with Tab to
 * toggle between the session's scoped models and the full catalogue.
 */
async function pickTargetModelTui(ctx: ExtensionContext): Promise<PickedModel | undefined> {
	const current = ctx.model;
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
						`Hand off to model — ${scope === "scoped" ? `scoped (${scopedEntries.length})` : `all (${allEntries.length})`}`,
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
 */
async function pickTargetModel(ctx: ExtensionContext): Promise<PickedModel | undefined> {
	if (ctx.mode === "tui") {
		return pickTargetModelTui(ctx);
	}
	return pickTargetModelFallback(ctx);
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

export default function (pi: ExtensionAPI) {
	// In-session state for the hand-off capture; fresh per extension instance,
	// so it never leaks into a replacement session.
	let awaitingHandoff = false;
	let capturedPrompt: string | undefined;
	let flowInProgress = false;

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
			"Hand the conversation to another model: pick the next model and thinking level, the agent writes the hand-off prompt, and it lands pre-filled in a fresh session's editor",
		handler: async (args, ctx) => {
			try {
				if (flowInProgress) {
					ctx.ui.notify("A hand-off is already in progress", "warning");
					return;
				}
				flowInProgress = true;
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the agent to finish before handing off", "info");
					await ctx.waitForIdle();
				}

				// 1. Pick the destination model.
				const target = await pickTargetModel(ctx);
				if (!target) return;

				// 2. Pick the thinking level (a scoped `model:level` entry pins it).
				const level = target.thinkingLevel ?? (await selectThinkingLevel(ctx));
				if (level === undefined) return;

				// 3. Collect steering instructions, pre-filled from /hand-off args.
				const steering = await ctx.ui.editor(
					"Steering for the hand-off prompt (sent to the current agent)",
					args.trim(),
				);
				if (steering === undefined) return;

				// 4. Ask the current agent to write the hand-off prompt.
				awaitingHandoff = true;
				capturedPrompt = undefined;
				await pi.sendMessage(
					{
						customType: HANDOFF_CUSTOM_TYPE,
						content: buildHandoffRequest(steering),
						display: true,
					},
					{ triggerTurn: true },
				);
				await ctx.waitForIdle();
				awaitingHandoff = false;

				if (!capturedPrompt) {
					ctx.ui.notify("The agent did not produce a hand-off prompt; staying in this session", "error");
					return;
				}

				// 5. Carry everything across session replacement as plain data.
				writeHandoff({
					provider: target.model.provider,
					modelId: target.model.id,
					thinkingLevel: level,
					prompt: capturedPrompt,
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
