/**
 * pi-clear — `/clear` for pi: start a fresh session without losing your model.
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
 * Usage:
 *   /clear
 *
 * Mechanism:
 *   1. The `/clear` handler captures the active model (provider + id) and
 *      thinking level as plain data into a `globalThis` property. Session
 *      replacement (`ctx.newSession()`) tears down the current runtime and
 *      recreates extension instances, but stays within the same process, so
 *      a `globalThis` property safely crosses that boundary while remaining
 *      invisible to other pi processes and dying with crashes.
 *   2. The new instance's `session_start` handler (reason: "new") consumes
 *      the handoff and applies the captured model and thinking level via
 *      `pi.setModel()` / `pi.setThinkingLevel()`, which record them in the
 *      new session so they also survive `/resume`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ClearHandoff {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

const HANDOFF_KEY = "__pi_clear_handoff__";

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function writeHandoff(handoff: ClearHandoff): void {
	(globalThis as Record<string, unknown>)[HANDOFF_KEY] = handoff;
}

/** Consume the handoff: read it and remove it so it can only apply once. */
function takeHandoff(): ClearHandoff | undefined {
	const store = globalThis as Record<string, unknown>;
	const handoff = store[HANDOFF_KEY];
	delete store[HANDOFF_KEY];
	return handoff as ClearHandoff | undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a fresh session, keeping the current model and thinking level",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.isIdle()) {
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
				if (result.cancelled) {
					takeHandoff();
					ctx.ui.notify("Clear cancelled by extension", "warning");
				}
			} catch (err) {
				takeHandoff();
				ctx.ui.notify(`Clear failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;

		const handoff = takeHandoff();
		if (!handoff) return;

		try {
			const model = ctx.modelRegistry.find(handoff.provider, handoff.modelId);
			if (!model) {
				ctx.ui.notify(`pi-clear: model ${handoff.provider}/${handoff.modelId} is no longer available`, "warning");
				return;
			}

			const applied = await pi.setModel(model);
			if (!applied) {
				ctx.ui.notify(`pi-clear: no auth configured for ${handoff.provider}/${handoff.modelId}`, "warning");
				return;
			}

			if (handoff.thinkingLevel && isThinkingLevel(handoff.thinkingLevel)) {
				pi.setThinkingLevel(handoff.thinkingLevel);
			}
		} catch (err) {
			ctx.ui.notify(
				`pi-clear: could not restore model ${handoff.provider}/${handoff.modelId}: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});
}
