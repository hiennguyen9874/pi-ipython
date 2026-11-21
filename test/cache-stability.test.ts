import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// ADR 0006: while the callable Pi tool set stays the same, nothing a request carried may change, so provider caches stay warm.

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const echo: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Echo text back.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "echo ran" }], details: {} }),
	});
};

interface Seen {
	descriptions: string[];
	systemPrompts: string[];
}

/** Wraps scripted replies so each provider request records its `ipython` description and system prompt. */
function recorder(): Seen & { step: (reply: ReturnType<typeof fauxAssistantMessage>) => FauxResponseStep } {
	const descriptions: string[] = [];
	const systemPrompts: string[] = [];
	return {
		descriptions,
		systemPrompts,
		step: (reply) => (context: Context) => {
			descriptions.push(getCurrentTools(context.messages).find((t) => t.name === "ipython")!.description);
			systemPrompts.push(getSystemMessageText(context.messages.find((m) => m.role === "system")!));
			return reply;
		},
	};
}

const cell = (code: string) => fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });

test.each([
	["an extension Pi tool registered", [echo]],
	["no Pi tools", []],
])("with %s, every request carries the same ipython description and system prompt", async (_name, extensions) => {
	h = await createHarness({
		mode: "rpc",
		extensions,
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ backgroundNotices: true }));
		},
	});
	const seen = recorder();
	h.setResponses([
		seen.step(cell("a = 1")),
		seen.step(cell("print(sorted(t['name'] for t in await pi.tools()))")),
		seen.step(cell("h = bash('sleep 0.3')")),
		seen.step(fauxAssistantMessage("started")),
		// The Background-command notice's turn.
		seen.step(fauxAssistantMessage("noted")),
	]);
	await h.session.prompt("first");
	await vi.waitFor(() => expect(seen.descriptions).toHaveLength(5), { timeout: 10_000, interval: 20 });
	await h.session.waitForIdle();
	h.setResponses([seen.step(cell("a + 1")), seen.step(fauxAssistantMessage("done"))]);
	await h.session.prompt("second");

	expect(seen.descriptions).toHaveLength(7);
	expect(new Set(seen.descriptions).size).toBe(1);
	expect(new Set(seen.systemPrompts).size).toBe(1);
	expect(seen.descriptions[0]!.includes("`echo`")).toBe(extensions.length > 0);
});
