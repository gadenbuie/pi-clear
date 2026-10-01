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
 *      thinking level as plain data and writes them to a small handoff file
 *      in the OS temp directory. Plain data is required because session
 *      replacement tears down the current runtime and stale session-bound
 *      objects throw when touched.
 *   2. `ctx.newSession()` replaces the session. New extension instances are
 *      created for the replacement session.
 *   3. The new instance's `session_start` handler (reason: "new") matches the
 *      handoff file's `previousSessionFile` against the event's
 *      `previousSessionFile`, then applies the captured model and thinking
 *      level via `pi.setModel()` / `pi.setThinkingLevel()`, which record them
 *      in the new session so they also survive `/resume`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ClearHandoff {
	/** Session file `/clear` was invoked from; used to validate the handoff. */
	previousSessionFile?: string | null;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
}

const HANDOFF_FILE = path.join(os.tmpdir(), "pi-clear-handoff.json");

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

function readHandoff(): ClearHandoff | undefined {
	try {
		const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, "utf8")) as ClearHandoff;
		return typeof handoff === "object" && handoff !== null ? handoff : undefined;
	} catch {
		return undefined;
	}
}

function writeHandoff(handoff: ClearHandoff): void {
	fs.writeFileSync(HANDOFF_FILE, JSON.stringify(handoff));
}

function clearHandoff(): void {
	fs.rmSync(HANDOFF_FILE, { force: true });
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a fresh session, keeping the current model and thinking level",
		handler: async (_args, ctx) => {
			try {
				if (!ctx.isIdle()) {
					await ctx.waitForIdle();
				}

				// Capture plain data only: it must survive session replacement.
				writeHandoff({
					previousSessionFile: ctx.sessionManager.getSessionFile() ?? null,
					provider: ctx.model?.provider,
					modelId: ctx.model?.id,
					thinkingLevel: ctx.thinkingLevel,
				});

				const result = await ctx.newSession();
				if (result.cancelled) {
					clearHandoff();
					ctx.ui.notify("Clear cancelled by extension", "warning");
				}
			} catch (err) {
				clearHandoff();
				ctx.ui.notify(`Clear failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;

		const handoff = readHandoff();
		if (!handoff) return;
		if ((handoff.previousSessionFile ?? null) !== (event.previousSessionFile ?? null)) return;
		clearHandoff();

		if (!handoff.provider || !handoff.modelId) return;

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
	});
}
