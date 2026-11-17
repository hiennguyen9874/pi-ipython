import { type Context, fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { PYTHON_STATE_TYPE } from "../src/index.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

/** `/compact`, with the faux model writing the summary. Keeps almost nothing, so small sessions compact. */
async function compact(harness: Harness): Promise<void> {
	harness.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
	// A second summary for when the cut splits a turn.
	harness.setResponses([fauxAssistantMessage("Summary of the conversation so far."), fauxAssistantMessage("Turn prefix summary.")]);
	await harness.session.compact();
}

/** Run one Cell in a new turn; returns its result and the context the model saw before calling it. */
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

function noticeEntries(harness: Harness) {
	return harness.session.sessionManager
		.getBranch()
		.flatMap((e) => (e.type === "custom_message" && e.customType === PYTHON_STATE_TYPE ? [e] : []));
}

test("after /compact, the next context lists the live Python names", async () => {
	h = await createHarness();
	await h.runCells("a = 1\nb = 'two'\n_private = 3\nimport json");

	await compact(h);
	const { result, seen } = await runCellSeeing(h, "a + 1");
	expect(seen).toContain("[python-state]");
	expect(seen).toContain("Your Python kernel persisted through compaction");
	expect(seen).toContain("These names are still defined: a, b, json.");
	expect(resultText(result)).toBe("2");
});

test("threshold compaction before a prompt puts the notice in that prompt's context", async () => {
	h = await createHarness();
	await h.runCells("a = 1");

	// Any context now exceeds the threshold (context window minus reserve), so the next prompt compacts first.
	const { contextWindow } = h.session.model!;
	h.session.settingsManager.applyOverrides({
		compaction: { enabled: true, reserveTokens: contextWindow - 1, keepRecentTokens: 1 },
	});
	let seen = "";
	// Summary requests share the queue with the prompt's request, which ends with the prompt.
	const reply = (context: Context) => {
		const last = context.messages.at(-1);
		if (last?.role !== "user" || JSON.stringify(last.content) !== JSON.stringify([{ type: "text", text: "continue" }])) {
			return fauxAssistantMessage("Summary.");
		}
		seen = JSON.stringify(context.messages);
		return fauxAssistantMessage("ok");
	};
	h.setResponses([reply, reply, reply, reply, reply]);
	await h.session.prompt("continue");
	expect(h.session.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(true);
	expect(seen).toContain("These names are still defined: a.");
});

test("no Python-state notice when the Kernel was never started", async () => {
	h = await createHarness();
	h.setResponses([fauxAssistantMessage("hi")]);
	await h.session.prompt("hello");

	await compact(h);
	expect(noticeEntries(h)).toEqual([]);
	const { seen } = await runCellSeeing(h, "1");
	expect(seen).not.toContain("[python-state]");
});

test("no Python-state notice after the Kernel was shut down", async () => {
	h = await createHarness();
	await h.runCells("a = 1");
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

	await compact(h);
	expect(noticeEntries(h)).toEqual([]);
});

test("back-to-back compactions each produce a fresh notice", async () => {
	h = await createHarness();
	await h.runCells("a = 1", "b = 2");

	await compact(h);
	await compact(h);
	const notices = noticeEntries(h);
	expect(notices).toHaveLength(2);
	const branch = h.session.sessionManager.getBranch();
	expect(branch.at(-1)).toBe(notices[1]);
	expect(branch.at(-2)?.type).toBe("compaction");

	const { seen } = await runCellSeeing(h, "c = 3");
	expect(seen).toContain("These names are still defined: a, b.");
	await compact(h);
	expect(noticeEntries(h).at(-1)?.content).toContain("These names are still defined: a, b, c.");
});

test("an empty namespace is reported as such", async () => {
	h = await createHarness();
	await h.runCells("1 + 1");

	await compact(h);
	expect(noticeEntries(h).at(-1)?.content).toContain("You have not defined any names yet.");
});
