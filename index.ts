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
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the agent to finish before handing off", "info");
					await ctx.waitForIdle();
				}

				// 1. Pick the destination model.
				const available = ctx.modelRegistry.getAvailable();
				const usable = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
				const models = usable.length > 0 ? usable : available;
				if (models.length === 0) {
					ctx.ui.notify("No models available to hand off to", "error");
					return;
				}
				const current = ctx.model;
				const ordered = current
					? [current, ...models.filter((m) => !sameModel(m, current))]
					: models;
				const labels = ordered.map((m) => modelLabel(m, current));
				const chosen = await ctx.ui.select("Hand off to model", labels);
				if (chosen === undefined) return;
				const target = ordered[labels.indexOf(chosen)];
				if (!target) return;

				// 2. Pick the thinking level.
				const level = await ctx.ui.select("Thinking level", [...THINKING_LEVELS]);
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
					provider: target.provider,
					modelId: target.id,
					thinkingLevel: level as ThinkingLevel,
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
			}
		},
	});

	pi.on("agent_end", (event) => {
		if (!awaitingHandoff) return;
		awaitingHandoff = false;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
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
