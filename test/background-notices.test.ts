import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, type HarnessOptions, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const NOTICE_TYPE = "ipython_bash_done";

function noticesOn({ cwd }: { cwd: string }): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ backgroundNotices: true }));
}

/** A session with notices on, in RPC mode (wake-ups need TUI or RPC). */
function harness(options: HarnessOptions = {}): Promise<Harness> {
	return createHarness({ setup: noticesOn, mode: "rpc", ...options });
}

type Notice = { content: string; details?: unknown };

function notices(harness: Harness): Notice[] {
	return harness.session.messages.filter((m) => m.role === "custom" && m.customType === NOTICE_TYPE) as unknown as Notice[];
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await sleep(20);
	}
}

const HANDLE_LINE = "Read its output with the handle's .output() or .tail(n), or `await` it.";

test("a Background command that finishes while idle wakes the model with a notice", async () => {
	h = await harness();
	const [started] = await h.runCells("h = bash('sleep 1; printf hi')\nh.pid");
	const pid = Number(resultText(started!));
	h.setResponses([fauxAssistantMessage("noted")]);

	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	expect(notices(h)[0]!.content).toBe(`[bash-done pid:${pid} exit:0]\n\nCommand: "sleep 1; printf hi"\n${HANDLE_LINE}`);
	const last = h.session.messages.at(-1);
	expect(last?.role === "assistant" && last.content).toEqual([{ type: "text", text: "noted" }]);
});

test("the notice says when the command's timeout killed it", async () => {
	h = await harness();
	const [started] = await h.runCells("h = bash('sleep 30', timeout=0.5)\nh.pid");
	const pid = Number(resultText(started!));
	h.setResponses([fauxAssistantMessage("noted")]);

	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	expect(notices(h)[0]!.content).toMatch(new RegExp(`^\\[bash-done pid:${pid} exit:-?\\d+\\]\n\nCommand: "sleep 30"\n\nKilled: still running after its 0.5 s timeout.\n`));
});

test.each([
	["the switch is off", { mode: "rpc" as const, setup: () => {} }],
	["the session runs in print mode", { mode: "print" as const }],
])("no notice and no turn when %s", async (_name, options) => {
	h = await harness(options);
	await h.runCells("h = bash('printf hi; touch finished')\nh.pid");
	await waitFor(() => existsSync(join(h!.cwd, "finished")));
	await sleep(1000);
	const count = h.session.messages.length;
	expect(notices(h)).toEqual([]);
	// The handle stays readable, without a warning in background output.
	const [read] = await h.runCells("h.output()");
	expect(resultText(read!)).toBe("'hi'");
	expect(read?.details).toMatchObject({ backgroundOutput: "" });
	expect(h.session.messages.length).toBe(count + 4);
});

/** The system prompt the provider receives for one run. */
async function providerSystemPrompt(harness: Harness): Promise<string> {
	let prompt = "";
	harness.setResponses([(context) => {
		const system = context.messages.find((m) => m.role === "system");
		prompt = system ? getSystemMessageText(system) : "";
		return fauxAssistantMessage("ok");
	}]);
	await harness.session.prompt("hi");
	return prompt;
}

const PROMPT_RULE = "even after your turn has ended. For long commands, start `h = bash(...)` and end your turn";

test("the prompt has the wake-up rule only when notices are on", async () => {
	h = await harness();
	expect(await providerSystemPrompt(h)).toContain(PROMPT_RULE);
	await h.dispose();
	h = await harness({ setup: () => {} });
	expect(await providerSystemPrompt(h)).not.toContain(PROMPT_RULE);
	await h.dispose();
	h = await harness({ mode: "print" });
	expect(await providerSystemPrompt(h)).not.toContain(PROMPT_RULE);
});

test("a command that finishes during a run notifies in a run of its own after it settles", async () => {
	const runs: string[] = [];
	h = await harness({ extensions: [(pi) => {
		pi.on("before_agent_start", (event) => void runs.push(event.messageType));
	}] });
	const [, waiting] = await h.runCells(
		"h = bash('sleep 0.2; printf hi')\nh.pid",
		"await asyncio.sleep(1)\nprint('own')",
	);
	expect(resultText(waiting!)).toBe("own");
	h.setResponses([fauxAssistantMessage("noted")]);
	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	expect(runs).toEqual(["user", "custom"]);
});

test("reading the handle before the notice is sent withdraws it", async () => {
	h = await harness();
	const [, , read] = await h.runCells(
		"h = bash('sleep 0.2; printf hi')\nh.pid",
		"await asyncio.sleep(1)",
		"h.output()",
	);
	expect(resultText(read!)).toBe("'hi'");
	await sleep(1000);
	expect(notices(h)).toEqual([]);
	expect(h.session.isIdle).toBe(true);
});

test("commands that finish close together wake the model once", async () => {
	h = await harness();
	await h.runCells("a = bash('sleep 0.6; printf a')\nb = bash('sleep 1.2; printf b')\n(a.pid, b.pid)");
	h.setResponses([fauxAssistantMessage("noted")]);
	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	await sleep(500);
	expect(notices(h)).toHaveLength(1);
	const [notice] = notices(h);
	expect(notice!.content).toMatch(/^\[bash-done pid:\d+ exit:0\]\n\nCommand: "sleep 0.6; printf a"\n\n\[bash-done pid:\d+ exit:0\]\n\nCommand: "sleep 1.2; printf b"\n/);
	expect(notice!.details).toMatchObject({ notices: [{ command: "sleep 0.6; printf a" }, { command: "sleep 1.2; printf b" }] });
});

test("after five wake-up turns in a row, notices wait for the user's next message", async () => {
	const notified: string[] = [];
	h = await harness({ ui: { notify: (message: string) => notified.push(message) } });
	const startAnother = () => [
		fauxAssistantMessage(fauxToolCall("ipython", { code: "h = bash('sleep 0.3')\nh.pid" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("waiting"),
	];
	await h.runCells("h = bash('sleep 0.5')\nh.pid");
	h.setResponses(Array.from({ length: 5 }, startAnother).flat());
	await waitFor(() => notices(h!).length === 5, 20_000);
	await h.session.waitForIdle();
	await waitFor(() => notified.length === 1);
	expect(notified[0]).toContain("paused");
	await sleep(500);
	expect(notices(h)).toHaveLength(5);

	h.setResponses([fauxAssistantMessage("ok")]);
	await h.session.prompt("status?");
	expect(notices(h)).toHaveLength(6);
	const userIndex = h.session.messages.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("status?"));
	expect(h.session.messages.indexOf(notices(h)[5] as never)).toBeGreaterThan(userIndex);
});
