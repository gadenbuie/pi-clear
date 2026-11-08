// Offline tests for the autonomous hand-off chain helpers.
// Run with Node 24+: node --test scripts/chain.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildChainNudge,
	buildChainPrompt,
	buildChainProtocol,
	decideBudgetAction,
	decideChainAction,
	parseChainArgs,
	parseChainSignal,
	sumUsage,
} from "../index.ts";

test("parseChainArgs", () => {
	assert.deepEqual(parseChainArgs("10 do PLAN.md"), { kind: "start", maxSteps: 10, maxCost: undefined, task: "do PLAN.md" });
	assert.deepEqual(parseChainArgs("3"), { kind: "start", maxSteps: 3, maxCost: undefined, task: "" });
	assert.deepEqual(parseChainArgs("off"), { kind: "off" });
	assert.deepEqual(parseChainArgs("status"), { kind: "status" });
	assert.deepEqual(parseChainArgs(""), { kind: "status" });
	assert.deepEqual(parseChainArgs("5 --max-cost 2.5 go"), { kind: "start", maxSteps: 5, maxCost: 2.5, task: "go" });
	assert.deepEqual(parseChainArgs("5 --max-cost=$3"), { kind: "start", maxSteps: 5, maxCost: 3, task: "" });
	// Flags only count before the task.
	assert.deepEqual(parseChainArgs("5 go --max-cost 2"), { kind: "start", maxSteps: 5, maxCost: undefined, task: "go --max-cost 2" });
	for (const bad of ["0", "x", "-2", "--chain 3", "5 --max-cost", "5 --max-cost 0", "5 --max-cost abc", "5 --max-cost=-1"]) {
		assert.equal(parseChainArgs(bad).kind, "error", bad);
	}
});

test("parseChainSignal accepts only a tag wrapping the whole message", () => {
	assert.deepEqual(parseChainSignal("\n<hand-off>\nDid step 1.\n</hand-off>\n"), { kind: "hand-off", body: "Did step 1." });
	assert.deepEqual(parseChainSignal("<hand-off done/>"), { kind: "done" });
	assert.deepEqual(parseChainSignal("<hand-off done />"), { kind: "done" });
	assert.deepEqual(parseChainSignal("All finished, nothing more."), { kind: "none" });
	assert.equal(parseChainSignal("<hand-off>  </hand-off>").kind, "invalid");
	assert.equal(parseChainSignal("Done!\n<hand-off>x</hand-off>").kind, "invalid");
	// A literal tag inside the body is text, not a nested hand-off.
	assert.deepEqual(parseChainSignal("<hand-off>a <hand-off>b</hand-off></hand-off>"), {
		kind: "hand-off",
		body: "a <hand-off>b</hand-off>",
	});
	const explains = "<hand-off>\nEnd with a `<hand-off>` block, not a fenced one.\n</hand-off>";
	assert.equal(parseChainSignal(explains).kind, "hand-off");
});

test("parseChainSignal ignores tags quoted in code fences", () => {
	const quoted = "Use this syntax:\n```\n<hand-off>body</hand-off>\n```\nthat's all.";
	assert.deepEqual(parseChainSignal(quoted), { kind: "none" });
	const inside = "<hand-off>\nTo hand off write:\n```\n<hand-off>x</hand-off>\n```\n</hand-off>";
	assert.equal(parseChainSignal(inside).kind, "hand-off");
});

test("sumUsage totals assistant usage and tolerates gaps", () => {
	const totals = sumUsage([
		{ role: "user" },
		{ role: "assistant", usage: { input: 10, output: 5, totalTokens: 20, cost: { total: 0.5 } } },
		{ role: "assistant", usage: { input: 1, output: 2 } },
		{ role: "assistant" },
	]);
	assert.deepEqual(totals, { input: 11, output: 7, total: 23, cost: 0.5 });
});

test("chain prompt carries provenance and the protocol", () => {
	const prompt = buildChainPrompt("Next: step 3.", { step: 3, maxSteps: 10, fromSessionId: "abc" });
	assert.match(prompt, /^<!-- pi-clear chain: step 3 of 10 · handed off from pi session abc -->/);
	assert.match(prompt, /Next: step 3\./);
	assert.match(prompt, /step 3 of 10/);
	assert.match(buildChainProtocol(10, 10), /last step/);
	assert.doesNotMatch(buildChainProtocol(2, 10), /last step/);
	assert.match(buildChainProtocol(0, 3), /step 0 of 3/);
	assert.doesNotMatch(buildChainProtocol(0, 3), /last step/);
});

test("parseChainSignal handles stop with a reason", () => {
	assert.deepEqual(parseChainSignal("<hand-off stop>tests fail: X</hand-off>"), { kind: "stop", reason: "tests fail: X" });
	assert.equal(parseChainSignal("<hand-off stop> </hand-off>").kind, "invalid");
	assert.equal(parseChainSignal("Blocked.\n<hand-off stop>x</hand-off>").kind, "invalid");
});

test("protocol offers done and stop, and no hand-off on the last step", () => {
	const mid = buildChainProtocol(2, 10);
	assert.match(mid, /<hand-off>/);
	assert.match(mid, /<hand-off done\/>/);
	assert.match(mid, /<hand-off stop>/);
	assert.match(buildChainProtocol(10, 10), /will be refused/);
	assert.match(buildChainNudge(2, 10, "it has no tag"), /it has no tag/);
});

const chain = (over = {}) => ({ maxSteps: 5, sessionIds: ["a", "b"], spent: 0, ...over });
const decide = (over = {}, chainOver = {}) =>
	decideChainAction({
		chain: chain(chainOver),
		sessionId: "b",
		aborted: false,
		last: { stopReason: "stop", text: "<hand-off>next</hand-off>" },
		sessionCost: 0.5,
		...over,
	});

test("decideChainAction hops with the new step and cumulative cost", () => {
	assert.deepEqual(decide({}, { spent: 1 }), { kind: "hop", body: "next", step: 1, spent: 1.5 });
});

test("decideChainAction ignores unrelated sessions and pending hops", () => {
	assert.equal(decide({ sessionId: "zzz" }).kind, "ignore");
	assert.equal(decide({ sessionId: "a" }).kind, "ignore");
	assert.equal(decide({}, { pending: { prompt: "p" } }).kind, "ignore");
});

test("decideChainAction stops on abort, bad stop reason, or missing message", () => {
	assert.equal(decide({ aborted: true }).kind, "stop");
	assert.equal(decide({ last: undefined }).kind, "stop");
	const length = decide({ last: { stopReason: "length", text: "<hand-off>x</hand-off>" } });
	assert.equal(length.kind, "stop");
	assert.equal(length.level, "error");
});

test("decideChainAction stops on done and on an agent stop reason", () => {
	const done = decide({ last: { stopReason: "stop", text: "<hand-off done/>" } });
	assert.deepEqual([done.kind, done.level], ["stop", "info"]);
	const stop = decide({ last: { stopReason: "stop", text: "<hand-off stop>need a key</hand-off>" } });
	assert.equal(stop.kind, "stop");
	assert.match(stop.reason, /need a key/);
});

test("decideChainAction nudges once on a missing or bad tag, then stops", () => {
	for (const text of ["All finished.", "<hand-off></hand-off>"]) {
		const last = { stopReason: "stop", text };
		assert.equal(decide({ last }).kind, "nudge", text);
		assert.equal(decide({ last }, { nudged: true }).kind, "stop", text);
	}
});

test("decideChainAction counts hand-offs, not the first agent, against the limit", () => {
	// maxSteps 5: the first agent is step 0, so the sixth session (step 5) is the last.
	const fifth = { sessionIds: ["a", "b", "c", "d", "e"] };
	assert.deepEqual(decide({ sessionId: "e" }, fifth), { kind: "hop", body: "next", step: 4, spent: 0.5 });
	assert.equal(decide({ sessionId: "a" }, { sessionIds: ["a"], maxSteps: 1 }).kind, "hop");
});

test("decideChainAction enforces the hand-off limit but still allows done/stop at it", () => {
	const atLimit = { sessionIds: ["a", "b", "c", "d", "e", "f"] };
	const refused = decide({ sessionId: "f" }, atLimit);
	assert.equal(refused.kind, "stop");
	assert.match(refused.reason, /limit of 5 hand-offs/);
	assert.equal(decide({ sessionId: "f", last: { stopReason: "stop", text: "<hand-off done/>" } }, atLimit).level, "info");
});

test("decideChainAction enforces --max-cost across sessions, before hop and nudge", () => {
	assert.equal(decide({}, { maxCost: 2, spent: 1 }).kind, "hop");
	// 95% or more of the limit left in the tank is too little to start another session.
	const over = decide({}, { maxCost: 2, spent: 1.4 });
	assert.equal(over.kind, "stop");
	assert.match(over.reason, /\$2\.00 limit/);
	assert.equal(decide({ last: { stopReason: "stop", text: "no tag" } }, { maxCost: 1, spent: 1 }).kind, "stop");
	assert.equal(decide({}, {}).kind, "hop");
});

test("decideBudgetAction ramps up and fires each level once", () => {
	const act = (spent, warned = 0, maxCost = 10) => decideBudgetAction({ maxCost, spent: 0, warned }, spent);
	assert.equal(act(7.9).kind, "none");
	assert.equal(decideBudgetAction({ spent: 5 }, 100).kind, "none"); // no limit
	const heads = act(8);
	assert.deepEqual([heads.kind, heads.level], ["warn", 1]);
	assert.match(heads.message, /heads-up/);
	assert.equal(act(8.5, 1).kind, "none");
	const stop = act(9.5, 1);
	assert.deepEqual([stop.kind, stop.level], ["warn", 2]);
	assert.match(stop.message, /Stop now/);
	const last = act(9.8, 2);
	assert.deepEqual([last.kind, last.level], ["warn", 3]);
	assert.match(last.message, /<hand-off stop>/);
	assert.equal(act(9.9, 3).kind, "none");
	assert.equal(act(10, 3).kind, "abort");
	assert.equal(act(12, 0).kind, "abort");
});

test("decideBudgetAction sends one message, the highest level, when a step jumps levels", () => {
	const jump = decideBudgetAction({ maxCost: 10, spent: 1, warned: 0 }, 8.9);
	assert.deepEqual([jump.kind, jump.level], ["warn", 3]);
	// spent already counts earlier sessions
	assert.equal(decideBudgetAction({ maxCost: 10, spent: 9.9, warned: 0 }, 0.1).kind, "abort");
});

test("pause is its own signal, distinct from stop and done", () => {
	assert.deepEqual(parseChainSignal("<hand-off pause>Which database?</hand-off>"), { kind: "pause", reason: "Which database?" });
	assert.equal(parseChainSignal("<hand-off pause> </hand-off>").kind, "invalid");
	assert.equal(parseChainSignal("Question below.\n<hand-off pause>x</hand-off>").kind, "invalid");
	assert.match(buildChainProtocol(1, 3), /<hand-off pause>/);
});

test("decideChainAction pauses without ending the chain, then resumes on the next settle", () => {
	const last = { stopReason: "stop", text: "<hand-off pause>Which database?</hand-off>" };
	assert.deepEqual(decide({ last }, { nudged: true }), { kind: "pause", reason: "Which database?" });
	// After the user replies the agent settles again; the chain evaluates it as usual.
	assert.equal(decide({}, { paused: true }).kind, "hop");
	assert.equal(decide({ last: { stopReason: "stop", text: "<hand-off done/>" } }, { paused: true }).kind, "stop");
	// A pause is allowed even on the last hand-off.
	const atLimit = { sessionIds: ["a", "b", "c", "d", "e", "f"] };
	assert.equal(decide({ sessionId: "f", last }, atLimit).kind, "pause");
});
