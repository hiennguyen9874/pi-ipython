import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness, type HarnessOptions, resultText, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const NOTICE_TYPE = "ipython_bash_done";

function writeNotices(cwd: string, on: boolean): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ backgroundNotices: on }));
}

function noticesOn({ cwd }: { cwd: string }): void {
	writeNotices(cwd, true);
}

function noticesOff({ cwd }: { cwd: string }): void {
	writeNotices(cwd, false);
}

/** A session with notices on, in RPC mode (notices need TUI or RPC). */
function harness(options: HarnessOptions = {}): Promise<Harness> {
	return createHarness({ setup: noticesOn, mode: "rpc", ...options });
}

type Notice = { content: string; details?: unknown };

function notices(harness: Harness): Notice[] {
	return harness.session.messages.filter((m) => m.role === "custom" && m.customType === NOTICE_TYPE && m.display) as unknown as Notice[];
}

function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
	return vi.waitFor(() => expect(predicate()).toBe(true), { timeout, interval: 20 });
}

const HANDLE_LINE = "Await its handle for the BashResult, or read output with the handle's .output() or .tail(n).";

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

test("a command that finishes inside its Cell does not start a turn", async () => {
	h = await harness();
	await h.runCells("h = bash('printf hi')\nwhile not h._reaped:\n    await asyncio.sleep(0.01)");
	await sleep(300);
	expect(notices(h)).toEqual([]);
	expect(h.session.isIdle).toBe(true);
});

test.each(["session_before_compact", "session_compact"] as const)("a notice queued in %s starts a turn after manual compaction", async (hook) => {
	let entered!: () => void;
	let release!: () => void;
	const compactionEntered = new Promise<void>((resolve) => { entered = resolve; });
	const releaseCompaction = new Promise<void>((resolve) => { release = resolve; });
	h = await harness({ extensions: [(pi) => {
		const holdCompaction = async () => {
			entered();
			await releaseCompaction;
		};
		if (hook === "session_before_compact") pi.on(hook, holdCompaction);
		else pi.on(hook, holdCompaction);
	}] });
	await h.runCells("1");
	await h.runCells("h = bash('while [ ! -f release ]; do sleep 0.02; done')\nh.pid");
	h.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
	const seen: string[] = [];
	h.setResponses(Array.from({ length: 3 }, () => () => {
		seen.push("response");
		return fauxAssistantMessage("summary or notice response");
	}));
	const compaction = h.session.compact();
	try {
		await Promise.race([compactionEntered, compaction]);
		writeFileSync(join(h.cwd, "release"), "");
		await sleep(300);
		expect(notices(h)).toEqual([]);
	} finally {
		release();
		await compaction;
	}
	await waitFor(() => notices(h!).length === 1, 1_500);
	await h.session.waitForIdle();
	expect(seen.length).toBeGreaterThan(1);
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

test("a command whose output dropped the middle names its Command log, deleted with the session", async () => {
	h = await harness();
	const [started] = await h.runCells("h = bash('sleep 0.5; seq 1 400000; echo last')\nh.pid");
	const pid = Number(resultText(started!));
	h.setResponses([fauxAssistantMessage("noted")]);

	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	const content = notices(h)[0]!.content;
	const logPath = /\n\nFull output: (\S+\.log)\n/.exec(content)?.[1];
	expect(content).toBe(`[bash-done pid:${pid} exit:0]\n\nCommand: "sleep 0.5; seq 1 400000; echo last"\n\nFull output: ${logPath}\n${HANDLE_LINE}`);
	expect(readFileSync(logPath!, "utf8")).toBe(`${Array.from({ length: 400_000 }, (_, i) => i + 1).join("\n")}\nlast\n`);

	const [tail] = await h.runCells("print(h.tail(1))");
	expect(resultText(tail!)).toMatch(new RegExp(`^\\.\\.\\. \\[\\d+ bytes dropped; full output in ${logPath}\\] \\.\\.\\.\nlast$`));

	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	expect(existsSync(dirname(dirname(logPath!)))).toBe(false);
});

test("a rotated Command log notice names both retained files without claiming full output", async () => {
	h = await harness({ setup: (dirs) => writeConfigs(dirs, {
		backgroundNotices: true,
		commandLog: { maxBytes: 2_500_000 },
	}) });
	const command = "while [ ! -f release ]; do sleep 0.02; done; seq 1 600000";
	const [started] = await h.runCells(`h = bash(${JSON.stringify(command)})\nh.pid`);
	const pid = Number(resultText(started!));
	h.setResponses([fauxAssistantMessage("noted")]);
	writeFileSync(join(h.cwd, "release"), "");

	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	const content = notices(h)[0]!.content;
	const logPath = /\n\nLatest output: (.+\.log)\.1 and \1\n/.exec(content)?.[1];
	expect(logPath).toBeDefined();
	expect(content).toBe(`[bash-done pid:${pid} exit:0]\n\nCommand: ${JSON.stringify(command)}\n\nLatest output: ${logPath}.1 and ${logPath}\n${HANDLE_LINE}`);
	expect(readFileSync(logPath! + ".1")).toHaveLength(2_500_000);
	expect(readFileSync(logPath!, "utf8").endsWith("600000\n")).toBe(true);
});

test.each([
	["the switch is off", { mode: "rpc" as const, setup: noticesOff }],
	["the session runs in print mode", { mode: "print" as const }],
])("no notice and no turn when %s", async (_name, options) => {
	h = await harness(options);
	await h.runCells("h = bash('sleep 0.2; printf hi; touch finished')\nh.pid");
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

const PROMPT_RULE = "end the turn rather than await it: keep its handle and say what is pending";

test("the prompt has the notice rule only when notices are on", async () => {
	h = await harness();
	const prompt = await providerSystemPrompt(h);
	const shell = prompt.split("## Shell commands\n")[1]?.split("\n## Python environments")[0];
	expect(shell).toContain("check it before reporting success");
	expect(shell).toContain(PROMPT_RULE);
	// How to read the result travels with the notice itself.
	expect(shell).toContain("A `[bash-done …]` notice starts a later turn for it, possibly batched with other commands or delayed.");
	await h.dispose();
	h = await harness({ setup: noticesOff });
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

test.each(["read", "shutdown"] as const)("a deferred notice is cancelled if the earlier prompt causes a %s", async (action) => {
	let defer = true;
	h = await harness({ extensions: [(pi) => {
		pi.on("agent_settled", async () => {
			if (!defer) return;
			defer = false;
			void pi.sendUserMessage("handle the completion first");
			writeFileSync(join(h!.cwd, "release"), "");
			// Let the notice reach pi while it is still dispatching the settled event.
			await sleep(300);
			if (action === "shutdown") await h!.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h!.setResponses(action === "read" ? [
				fauxAssistantMessage(fauxToolCall("ipython", { code: "h.output()" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("read"),
				() => { throw new Error("unexpected notice turn"); },
			] : [fauxAssistantMessage("ok")]);
		});
	}] });
	await h.runCells("h = bash('while [ ! -f release ]; do sleep 0.02; done; printf hi')\nh.pid");
	await h.session.waitForIdle();
	expect(notices(h)).toEqual([]);
	expect(h.session.messages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(false);
});

test("commands that finish close together notify the model in one turn", async () => {
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

test("a user message does not pull a notice out of an unpaused batch", async () => {
	h = await harness();
	await h.runCells("a = bash('sleep 0.2; touch first-finished')\nb = bash('while [ ! -f release ]; do sleep 0.02; done')\n(a.pid, b.pid)");
	await waitFor(() => existsSync(join(h!.cwd, "first-finished")));
	await sleep(150);

	h.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("noted")]);
	await h.session.prompt("hello");
	expect(notices(h)).toEqual([]);

	writeFileSync(join(h.cwd, "release"), "");
	await waitFor(() => notices(h!).length === 1);
	await h.session.waitForIdle();
	expect(notices(h)[0]!.details).toMatchObject({ notices: [{ command: "sleep 0.2; touch first-finished" }, { command: expect.stringContaining("release") }] });
});

test("after five consecutive turns started by notices, notices wait for the user's next message", async () => {
	const notified: string[] = [];
	h = await harness({ ui: { notify: (message: string) => notified.push(message) } });
	const startAnother = (command: string) => [
		fauxAssistantMessage(fauxToolCall("ipython", { code: `h = bash(${JSON.stringify(command)})\nh.pid` }), { stopReason: "toolUse" }),
		fauxAssistantMessage("waiting"),
	];
	await h.runCells("h = bash('sleep 0.5')\nh.pid");
	h.setResponses([
		...Array.from({ length: 4 }, () => startAnother("sleep 0.3")).flat(),
		...startAnother("while [ ! -f release ]; do sleep 0.02; done; touch finished"),
	]);
	await waitFor(() => notices(h!).length === 5, 20_000);
	await h.session.waitForIdle();
	await waitFor(() => notified.length === 1);
	expect(notified[0]).toContain("paused");
	writeFileSync(join(h.cwd, "release"), "");
	await waitFor(() => existsSync(join(h!.cwd, "finished")));
	await sleep(150);
	expect(notices(h)).toHaveLength(5);

	h.setResponses([fauxAssistantMessage("ok")]);
	await h.session.prompt("status?");
	expect(notices(h)).toHaveLength(6);
	const userIndex = h.session.messages.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("status?"));
	expect(h.session.messages.indexOf(notices(h)[5] as never)).toBeGreaterThan(userIndex);
});
