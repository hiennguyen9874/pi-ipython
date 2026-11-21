import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** Whether the `later` request starts with every message of `earlier`, as sent (providers do not send timestamps). */
function extendsRequest(later: string, earlier: string): boolean {
	const sent = (json: string) => (JSON.parse(json) as unknown[]).map((m) => JSON.stringify(m, (key, value) => key === "timestamp" ? undefined : value));
	const before = sent(earlier);
	return JSON.stringify(sent(later).slice(0, before.length)) === JSON.stringify(before);
}

function noticeEntries(harness: Harness) {
	return harness.session.sessionManager
		.getBranch()
		.flatMap((e) => (e.type === "custom_message" && e.customType === PYTHON_STATE_TYPE ? [e] : []));
}

test("after /compact, the next context lists the live Python names", async () => {
	h = await createHarness();
	await h.runCells("a = 1\nb = 'two'\n_private = 3\nimport base64");

	await compact(h);
	const { result, seen } = await runCellSeeing(h, "a + 1");
	expect(seen).toContain("[python-state]");
	expect(seen).toContain("Your Python kernel persisted through compaction");
	expect(seen).toContain("These names are still defined: a, b, base64.");
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

test("compaction preserves background text and images for the next Cell", async () => {
	h = await createHarness();
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	await h.runCells(`import threading\nfrom rlm.repl import emit\ndef later():\n    print('late output')\n    emit({'image/png': '${png}'})\nthreading.Timer(0.1, later).start()`);
	await new Promise((resolve) => setTimeout(resolve, 300));

	await compact(h);
	const { result } = await runCellSeeing(h, "1");
	expect(resultText(result)).toBe("1\n[background output]\nlate output");
	expect(result.content.filter((b) => b.type === "image")).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
	const [next] = await h.runCells("2");
	expect(resultText(next!)).toBe("2");
	expect(next!.content.some((b) => b.type === "image")).toBe(false);
});

test.each(["threshold", "overflow"] as const)("%s compaction during a run reaches the immediate next request once", async (reason) => {
	h = await createHarness();
	await h.runCells("a = 1");
	h.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
	let seen = "";
	let requests = 0;
	const reasons: string[] = [];
	h.session.subscribe((event) => {
		if (event.type === "compaction_start") reasons.push(event.reason);
	});
	// Summary count depends on whether the cut splits the turn; identify requests by their system prompt.
	const reply = (context: Context) => {
		if (!context.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("persistent CPython"))) {
			return fauxAssistantMessage("Summary.");
		}
		requests++;
		seen = JSON.stringify(context.messages);
		h!.session.settingsManager.applyOverrides({ compaction: { enabled: false } });
		return fauxAssistantMessage("done");
	};
	// Both summary requests and the continuation use the same scripted provider.
	h.setResponses([
		() => {
			requests++;
			if (reason === "overflow") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "context window exceeded" });
			// Cross the threshold only after this request starts, forcing compaction between Cells.
			h!.session.settingsManager.applyOverrides({ compaction: { reserveTokens: h!.session.model!.contextWindow - 1 } });
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "b = 2" }), { stopReason: "toolUse" });
		},
		reply, reply, reply, reply,
	]);
	await h.session.prompt("continue");
	expect(reasons).toContain(reason);
	expect(seen).toContain(reason === "threshold" ? "These names are still defined: a, b." : "These names are still defined: a.");
	expect(seen.match(/\[python-state\]/g)).toHaveLength(1);
	expect(requests).toBe(2);
	expect(noticeEntries(h)).toHaveLength(1);
	const { seen: later } = await runCellSeeing(h, "a + 1");
	expect(later.match(/\[python-state\]/g)).toHaveLength(1);
	// pi persisted the notice after the turn; later requests keep it where the model first saw it (ADR 0006).
	expect(extendsRequest(later, seen)).toBe(true);
});

test.each(["error", "timeout"] as const)("a listing %s sends a no-names notice and keeps Python state", async (failure) => {
	h = await createHarness();
	await h.runCells([
		"a = 41",
		"import rlm.repl as repl",
		"_original_list_names = repl._list_names",
		"def _listing(ns):",
		"    repl._list_names = _original_list_names",
		failure === "error" ? "    raise RuntimeError('listing failed')" : "    __import__('time').sleep(5.2)",
		"    return _original_list_names(ns)",
		"repl._list_names = _listing",
	].join("\n"));
	const started = Date.now();
	await compact(h);
	expect(Date.now() - started).toBeLessThan(8_000);
	const notice = noticeEntries(h).at(-1)!;
	expect(notice.content).toContain("Your Python kernel persisted through compaction");
	expect(notice.content).not.toContain("These names");
	expect(notice.content).toContain("Could not list Python names; inspect `globals()`");
	const { result } = await runCellSeeing(h, "a + 1");
	expect(resultText(result)).toBe("42");
	await compact(h);
	expect(noticeEntries(h).at(-1)?.content).toContain("These names are still defined: a, repl.");
});

test("no notice is sent when the Kernel dies during listing", async () => {
	h = await createHarness();
	await h.runCells("import rlm.repl as repl\nrepl._list_names = lambda ns: __import__('os')._exit(17)");
	await compact(h);
	expect(noticeEntries(h)).toEqual([]);
});

test.skipIf(process.platform === "win32")("a busy interrupted Cell gets a no-names notice without another interrupt", async () => {
	h = await createHarness();
	await h.runCells("a = 41");
	const started = join(h.cwd, "started");
	const release = join(h.cwd, "release");
	h.setResponses([fauxAssistantMessage(fauxToolCall("ipython", { code: [
		"import os, signal, time",
		"signal.signal(signal.SIGINT, lambda *_: open('interrupts', 'a').write('x'))",
		`open(${JSON.stringify(started)}, 'w').close()`,
		`while not os.path.exists(${JSON.stringify(release)}): time.sleep(0.02)`,
	].join("\n") }), { stopReason: "toolUse" })]);
	const run = h.session.prompt("run");
	try {
		await expect.poll(() => existsSync(started)).toBe(true);
		await h.session.abort();
		await run;
		const interrupts = readFileSync(join(h.cwd, "interrupts"), "utf8");
		const before = Date.now();
		await compact(h);
		expect(readFileSync(join(h.cwd, "interrupts"), "utf8")).toBe(interrupts);
		expect(Date.now() - before).toBeLessThan(2_000);
		expect(noticeEntries(h).at(-1)?.content).toContain("Your Python kernel persisted through compaction");
		expect(noticeEntries(h).at(-1)?.content).not.toContain("These names");
	} finally {
		writeFileSync(release, "");
	}
	const { result } = await runCellSeeing(h, "a + 1");
	expect(resultText(result)).toBe("42");
});

test("a Kernel that dies after compaction during a run leaves the State-loss notice as the latest word", async () => {
	const beforeLoss = fauxToolCall("ipython", { code: "b = 2" });
	const loseKernel = fauxToolCall("ipython", { code: "import os; os._exit(17)" });
	h = await createHarness({
		extensionsBefore: [(pi) => {
			pi.on("context", ({ messages }) => {
				// Same-timestamp messages on both sides of the notice must not move it.
				for (const [id, notes] of [
					[beforeLoss.id, ["First note.", "Second note."]],
					[loseKernel.id, ["Third note."]],
				] as const) {
					const at = messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === id);
					if (at >= 0) messages.splice(at + 1, 0, ...notes.map((content) => ({
						role: "user" as const, content, timestamp: 1,
					})));
				}
			});
		}],
	});
	await h.runCells("a = 1");
	h.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
	const isMain = (context: Context) =>
		context.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("persistent CPython"));
	const main = [
		() => {
			// Cross the threshold only after this request starts, forcing compaction between Cells.
			h!.session.settingsManager.applyOverrides({ compaction: { reserveTokens: h!.session.model!.contextWindow - 1 } });
			return fauxAssistantMessage(beforeLoss, { stopReason: "toolUse" });
		},
		() => {
			h!.session.settingsManager.applyOverrides({ compaction: { enabled: false } });
			return fauxAssistantMessage(loseKernel, { stopReason: "toolUse" });
		},
	];
	let seen = "";
	let carried = "";
	const reply = (context: Context) => {
		if (!isMain(context)) return fauxAssistantMessage("Summary.");
		const next = main.shift();
		// The request that runs the Cell killing the Kernel carries the deferred notice.
		if (main.length === 0 && next) carried = JSON.stringify(context.messages);
		if (next) return next();
		seen = JSON.stringify(context.messages);
		return fauxAssistantMessage("done");
	};
	h.setResponses([reply, reply, reply, reply, reply, reply]);
	await h.session.prompt("continue");
	expect(seen).toContain("ipython_state_lost");
	// The notice the model already saw stays (ADR 0006), and the State-loss notice after it corrects it.
	expect(seen.match(/\[python-state\]/g)).toHaveLength(1);
	expect(JSON.parse(carried).slice(-3)).toEqual([
		expect.objectContaining({ role: "user", content: "First note." }),
		expect.objectContaining({ role: "user", content: "Second note." }),
		expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining("[python-state]") })] }),
	]);
	expect(seen.indexOf("[python-state]")).toBeLessThan(seen.lastIndexOf("ipython_state_lost"));
	expect(seen.indexOf("Third note.")).toBeGreaterThan(seen.indexOf("[python-state]"));
	expect(extendsRequest(seen, carried)).toBe(true);
	expect(noticeEntries(h)).toHaveLength(1);
});

test("a notice no request carried is dropped when its Kernel dies first", async () => {
	let pid = 0;
	h = await createHarness({
		extensions: [(pi) => {
			// Runs after pi-ipython queued the notice, before the next request.
			pi.on("session_compact", async () => {
				process.kill(pid, "SIGKILL");
				await new Promise((resolve) => setTimeout(resolve, 500));
			});
		}],
	});
	const [started] = await h.runCells("import os; a = 1; os.getpid()");
	pid = Number(resultText(started!));
	h.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
	const isMain = (context: Context) =>
		context.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("persistent CPython"));
	const seen: string[] = [];
	const main = [
		() => {
			h!.session.settingsManager.applyOverrides({ compaction: { reserveTokens: h!.session.model!.contextWindow - 1 } });
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "b = 2" }), { stopReason: "toolUse" });
		},
		() => {
			h!.session.settingsManager.applyOverrides({ compaction: { enabled: false } });
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "a" }), { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage("done"),
	];
	const reply = (context: Context) => {
		if (!isMain(context)) return fauxAssistantMessage("Summary.");
		seen.push(JSON.stringify(context.messages));
		return main.shift()!();
	};
	h.setResponses([reply, reply, reply, reply, reply, reply]);
	await h.session.prompt("continue");
	expect(seen).toHaveLength(3);
	expect(seen[1]).not.toContain("[python-state]");
	expect(seen[2]).not.toContain("[python-state]");
	expect(seen[2]).toContain("ipython_state_lost");
	const { seen: later } = await runCellSeeing(h, "1");
	expect(later).not.toContain("[python-state]");
});

test.each([50, 51])("notice caps the count with %i eligible names", async (count) => {
	h = await createHarness();
	await h.runCells(`for _i in range(${count}): globals()[f"name_{_i:03}"] = _i\n_private = 1\nopen = 2`);
	await compact(h);
	const content = noticeEntries(h).at(-1)!.content as string;
	expect(content.length).toBeLessThanOrEqual(2_000);
	expect(content).toContain("These names are still defined: name_000, name_001");
	expect(content).toContain("name_049");
	expect(content).not.toContain("name_050");
	expect(content).toContain("Private and bootstrap names are not listed");
	if (count === 51) expect(content).toContain("1 more omitted; inspect `globals()`");
	else expect(content).not.toContain("more omitted");
});

test("character cap omits a long name and all later names without truncating names", async () => {
	h = await createHarness();
	await h.runCells("a = 1\nglobals()['b' * 2000] = 2\nz = 3");
	await compact(h);
	const content = noticeEntries(h).at(-1)!.content as string;
	expect(content.length).toBeLessThanOrEqual(2_000);
	expect(content).toContain("These names are still defined: a.");
	expect(content).toContain("2 more omitted; inspect `globals()`");
	expect(content).not.toContain("b".repeat(20));
});

test("the character limit includes all notice wording", async () => {
	h = await createHarness();
	await h.runCells("a = 1");
	await compact(h);
	const initial = noticeEntries(h).at(-1)!.content as string;
	const nameLength = 2_000 - initial.length + 1;
	await h.runCells(`del a\nglobals()['b' * ${nameLength}] = 1`);
	await compact(h);
	const exact = noticeEntries(h).at(-1)!.content as string;
	expect(exact.length).toBe(2_000);
	expect(exact).not.toContain("more omitted");
	await h.runCells(`del globals()['b' * ${nameLength}]\nglobals()['b' * ${nameLength + 1}] = 1`);
	await compact(h);
	const over = noticeEntries(h).at(-1)!.content as string;
	expect(over.length).toBeLessThanOrEqual(2_000);
	expect(over).toContain("1 more omitted; inspect `globals()`");
});

test("an oversized first name is counted without a misleading empty namespace", async () => {
	h = await createHarness();
	await h.runCells("globals()['a' * 3000] = 1");
	await compact(h);
	const content = noticeEntries(h).at(-1)!.content as string;
	expect(content.length).toBeLessThanOrEqual(2_000);
	expect(content).toContain("1 more omitted; inspect `globals()`");
	expect(content).not.toContain("No eligible names");
});

test("unusual names are escaped and objects are not inspected", async () => {
	h = await createHarness();
	await h.runCells([
		"class _NoRepr:",
		"    def __repr__(self): raise RuntimeError('repr must not run')",
		"safe = _NoRepr()",
		"globals()['a, b\\nspoof'] = safe",
		"globals()['é'] = safe",
	].join("\n"));
	await compact(h);
	const content = noticeEntries(h).at(-1)!.content as string;
	expect(content).toContain(JSON.stringify("a, b\nspoof"));
	expect(content).toContain('"é"');
	expect(content).toContain("safe");
	expect(content).not.toContain("repr must not run");
});

test("listing string-subclass keys does not invoke their user-defined methods", async () => {
	h = await createHarness();
	await h.runCells([
		"class _Key(str):",
		"    def startswith(self, *_args): raise RuntimeError('user startswith ran')",
		"    def __lt__(self, _other): raise RuntimeError('user comparison ran')",
		"    def __str__(self): raise RuntimeError('user str ran')",
		"    def __repr__(self): raise RuntimeError('user repr ran')",
		"globals()[_Key('custom')] = 1",
		"class _NonString:",
		"    @property",
		"    def __class__(self): raise RuntimeError('user class property ran')",
		"globals()[_NonString()] = 3",
		"z = 2",
	].join("\n"));
	await compact(h);
	const content = noticeEntries(h).at(-1)!.content as string;
	expect(content).toContain("These names are still defined: custom, z.");
	expect(content).not.toContain("Could not list");
});

test("an empty namespace is reported as such", async () => {
	h = await createHarness();
	await h.runCells("1 + 1");

	await compact(h);
	expect(noticeEntries(h).at(-1)?.content).toContain("No eligible names to list.");
});
