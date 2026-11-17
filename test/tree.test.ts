import { setTimeout as sleep } from "node:timers/promises";
import { type Context, fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { BRANCH_NOTICE, STATE_LOST_NOTICE } from "../src/index.ts";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

/** The State-loss notice as it appears in a JSON-stringified context. */
const SEEN_STATE_LOST = JSON.stringify(STATE_LOST_NOTICE).slice(1, -1);

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

/** Navigate `/tree`-style back to before the first prompt (pi's leaf goes to the root). */
async function navigateToStart(harness: Harness): Promise<void> {
	const first = harness.session.sessionManager.getEntries().find((e) => e.type === "message" && e.message.role === "user")!;
	const result = await harness.session.navigateTree(first.id);
	expect(result.cancelled).toBe(false);
}

/** Run one Cell on the current branch; returns its result and the context the model saw before calling it. */
async function runCellSeeing(harness: Harness, code: string): Promise<{ result: ToolResultMessage; seen: string }> {
	let seen = "";
	harness.setResponses([
		(context: Context) => {
			seen = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("done"),
	]);
	const before = harness.session.messages.length;
	await harness.session.prompt("continue");
	const result = harness.session.messages.slice(before).find((m): m is ToolResultMessage => m.role === "toolResult")!;
	return { result, seen };
}

function withChoice(choice: string | undefined) {
	const prompts: { title: string; options: string[] }[] = [];
	const ui = {
		select: async (title: string, options: string[]) => {
			prompts.push({ title, options });
			return choice;
		},
	};
	return { prompts, ui };
}

test("Restart Kernel on /tree loses Python state and tells the model", async () => {
	const { prompts, ui } = withChoice("Restart Kernel");
	const notifications: string[] = [];
	h = await createHarness({ ui: { ...ui, notify: (message: string) => { notifications.push(message); } } });
	const [first] = await h.runCells("x = 41\nimport os; os.getpid()");
	const pid = Number(resultText(first!));

	await navigateToStart(h);
	expect(prompts).toHaveLength(1);
	expect(prompts[0]!.options).toEqual(["Keep Kernel", "Restart Kernel"]);
	expect(notifications).toContain("Kernel stopped; earlier Python state is unavailable.");
	expect(kernelPids()).not.toContain(pid);

	const { result, seen } = await runCellSeeing(h, "x + 1");
	expect(seen).toContain(SEEN_STATE_LOST);
	expect(seen).not.toContain(BRANCH_NOTICE);
	expect(resultText(result)).toContain("NameError");
});

test("a Kernel dying during /tree restart is announced once and the first Cell runs", async () => {
	let pid = 0;
	h = await createHarness({ ui: { select: async () => {
		process.kill(pid, "SIGKILL");
		await sleep(200);
		return "Restart Kernel";
	} } });
	const [first] = await h.runCells("import os; os.getpid()");
	pid = Number(resultText(first!));
	await navigateToStart(h);
	const { result, seen } = await runCellSeeing(h, "40 + 2");
	expect(seen).toContain(SEEN_STATE_LOST);
	expect(result.isError).toBe(false);
	expect(resultText(result)).toBe("42");
});

test("Keep Kernel on /tree preserves Python state and warns it may not match the branch", async () => {
	const { prompts, ui } = withChoice("Keep Kernel");
	h = await createHarness({ ui });
	await h.runCells("x = 41");

	await navigateToStart(h);
	expect(prompts).toHaveLength(1);

	const { result, seen } = await runCellSeeing(h, "x + 1");
	expect(seen).toContain(BRANCH_NOTICE);
	expect(seen).not.toContain(SEEN_STATE_LOST);
	expect(resultText(result)).toBe("42");
});

test("dismissing the /tree choice keeps the Kernel", async () => {
	const { ui } = withChoice(undefined);
	h = await createHarness({ ui });
	await h.runCells("x = 41");

	await navigateToStart(h);
	const { result, seen } = await runCellSeeing(h, "x + 1");
	expect(seen).toContain(BRANCH_NOTICE);
	expect(resultText(result)).toBe("42");
});

test("without a UI, /tree keeps the Kernel and notifies the model without prompting", async () => {
	h = await createHarness();
	await h.runCells("x = 41");

	await navigateToStart(h);
	const { result, seen } = await runCellSeeing(h, "x + 1");
	expect(seen).toContain(BRANCH_NOTICE);
	expect(resultText(result)).toBe("42");
});

test("RPC /tree keeps the Kernel and notifies the model without prompting a bound UI", async () => {
	const { prompts, ui } = withChoice("Restart Kernel");
	h = await createHarness({ ui, mode: "rpc" });
	await h.runCells("x = 41");

	await navigateToStart(h);
	expect(prompts).toEqual([]);

	const { result, seen } = await runCellSeeing(h, "x + 1");
	expect(seen).toContain(BRANCH_NOTICE);
	expect(seen).not.toContain(SEEN_STATE_LOST);
	expect(resultText(result)).toBe("42");
});

test("/tree with no Kernel running neither prompts nor notifies", async () => {
	const { prompts, ui } = withChoice("Restart Kernel");
	h = await createHarness({ ui });
	h.setResponses([fauxAssistantMessage("hi")]);
	await h.session.prompt("hello");

	await navigateToStart(h);
	expect(prompts).toEqual([]);
	const { seen } = await runCellSeeing(h, "1");
	expect(seen).not.toContain(BRANCH_NOTICE);
	expect(seen).not.toContain(SEEN_STATE_LOST);
});
