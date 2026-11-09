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
 * Mechanism:
 *   `/clear` captures the model and thinking level as plain data into a
 *   `globalThis` property. Session replacement (`ctx.newSession()`) tears down
 *   the current runtime and recreates extension instances, but stays within
 *   the same process, so a `globalThis` property safely crosses that boundary
 *   while remaining invisible to other pi processes and dying with crashes.
 *
 *   The new instance's `session_start` handler (reason: "new") consumes it and
 *   applies the model and thinking level via `pi.setModel()` /
 *   `pi.setThinkingLevel()`, which record them in the new session so they
 *   also survive `/resume`.
 *
 * `/hand-off` and `/hand-off-relay` used to live here; they are now in
 * `@grrrck/pi-hand-off`. Because people upgrading would otherwise just find
 * `/hand-off` gone, the first interactive startup shows a one-time notice
 * pointing there — unless a `/hand-off` command already exists (the new
 * package is installed). "Shown" is a marker file in the agent dir, the only
 * thing this extension writes. Remove the notice once the move is old news.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

/** State carried across session replacement via `globalThis`. */
export interface SessionHandoff {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
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

export const MOVED_NOTICE =
	"pi-clear 0.6 only provides /clear now. /hand-off moved to @grrrck/pi-hand-off: pi install npm:@grrrck/pi-hand-off";

const NOTICE_MARKER = "pi-clear-moved-notice";

/** Show the notice once: true when it should be shown now (and records that it was). */
export function takeMovedNotice(agentDir: string = getAgentDir()): boolean {
	const marker = join(agentDir, NOTICE_MARKER);
	if (existsSync(marker)) return false;
	try {
		mkdirSync(dirname(marker), { recursive: true });
		writeFileSync(marker, "shown\n");
	} catch {
		// Cannot record it; stay quiet rather than repeat on every start.
		return false;
	}
	return true;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function (pi: ExtensionAPI) {
	/** Apply a captured model and thinking level, reporting problems as warnings. */
	async function applyHandoffModel(handoff: SessionHandoff, ctx: ExtensionContext): Promise<void> {
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

			if (handoff.thinkingLevel) {
				await pi.setThinkingLevel(handoff.thinkingLevel);
			}
		} catch (err) {
			ctx.ui.notify(
				`pi-clear: could not restore model ${handoff.provider}/${handoff.modelId}: ${messageOf(err)}`,
				"warning",
			);
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
				ctx.ui.notify(`Clear failed: ${messageOf(err)}`, "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && ctx.hasUI && !pi.getCommands().some((c) => c.name === "hand-off")) {
			if (takeMovedNotice()) ctx.ui.notify(MOVED_NOTICE, "info");
		}
		if (event.reason !== "new") return;

		const handoff = takeHandoff();
		if (!handoff) return;

		await applyHandoffModel(handoff, ctx);
	});
}
