import { readFile, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import {
	type ClassifierAnswer,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getCurrentTools,
	getSystemMessageText,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { initTheme, ModelRegistry, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createHarness, FAUX_CLASSIFIER, type Harness, type HarnessOptions, kernelPids, resultText, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await h?.dispose();
	h = undefined;
});
beforeAll(() => initTheme("dark"));

/** What one Model call sent. */
interface ModelRequest {
	model: string;
	modelMaxTokens: number;
	system: string | undefined;
	prompt: string;
	options: SimpleStreamOptions | undefined;
}

type ModelReply = (request: ModelRequest, options: SimpleStreamOptions | undefined) => ReturnType<FauxResponseFactory>;

const echo: ModelReply = (request) => fauxAssistantMessage(`answer: ${request.prompt}`);

/**
 * Run `code` as one Cell. Requests declaring no tools are Model calls, answered by `reply` and recorded
 * in `requests`; the rest are the session's turns. Returns the Cell's tool result and the `ipython`
 * description the model saw.
 */
async function runCell(harness: Harness, code: string, reply: ModelReply = echo, requests: ModelRequest[] = []) {
	let turns = 0;
	let description = "";
	const router: FauxResponseFactory = (context: TranscriptContext, options, _state, model) => {
		const tools = getCurrentTools(context.messages);
		if (tools.length === 0) {
			const system = context.messages.find((m) => m.role === "system");
			const user = context.messages.find((m) => m.role === "user");
			const request: ModelRequest = {
				model: `${model.provider}/${model.id}`,
				modelMaxTokens: model.maxTokens,
				system: system && getSystemMessageText(system),
				prompt: typeof user?.content === "string" ? user.content : "",
				options,
			};
			requests.push(request);
			return reply(request, options);
		}
		if (++turns > 1) return fauxAssistantMessage("done");
		description = tools.find((tool) => tool.name === "ipython")?.description ?? "";
		return fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });
	};
	harness.setResponses(Array.from({ length: 200 }, () => router));
	const before = harness.session.messages.length;
	await harness.session.prompt("run the cell");
	const result = harness.session.messages.slice(before).find((m): m is ToolResultMessage => m.role === "toolResult")!;
	return { result, text: resultText(result), description, requests };
}

function enabled(modelCalls: Record<string, unknown> = {}): HarnessOptions["setup"] {
	return (dirs) => writeConfigs(dirs, { modelCalls: { enabled: true, ...modelCalls } });
}

const CATCH = (call: string) => [
	"try:",
	`    print(${call})`,
	"except pi.ModelCallError as e:",
	"    print(f'ModelCallError: {e}')",
].join("\n");

test("Model calls are off by default: pi.ask raises pi.ModelCallError, sends nothing, and the description has no pi.ask", async () => {
	h = await createHarness();
	const { result, text, description, requests } = await runCell(h, [
		"print(issubclass(pi.ModelCallError, RuntimeError), 'ModelCallError' in pi.__all__, 'ask' in pi.__all__)",
		CATCH("await pi.ask('hi')"),
	].join("\n"));
	expect(result.isError).toBe(false);
	expect(text).toBe("True True True\nModelCallError: Model calls are turned off (modelCalls.enabled: false)");
	expect(requests).toEqual([]);
	expect(result.usage).toBeUndefined();
	expect(description).not.toContain("pi.ask");
	expect(description).not.toContain("ModelCallError");
});

test("turning Model calls on appends only the pi.ask paragraph to the description, naming the limit and no model", async () => {
	h = await createHarness();
	const off = (await runCell(h, "1")).description;
	await h.dispose();
	h = await createHarness({ setup: enabled({ maxPerCell: 7, model: "faux/faux-1" }) });
	const on = (await runCell(h, "1")).description;
	expect(on.startsWith(`${off}\n\n`)).toBe(true);
	const paragraph = on.slice(off.length + 2);
	const [limits, lifetime, signature, ...guidance] = paragraph.split("\n");
	expect(limits).toMatch(/^- Model calls \(`pi\.ask`\): at most 7 total per Cell, with at most 8 in flight\./);
	expect(limits).toContain("remaining Cell budget");
	expect(lifetime).toContain("Await Model calls in their originating Cell. Failed requests raise `pi.ModelCallError`.");
	expect(signature).toMatch(/^- `await pi\.ask\(prompt: str, \*, system: str \| None = None\) -> str`/);
	expect(guidance.join("\n")).toContain("request a structured answer and validate it");
	expect(guidance.join("\n")).toContain("return_exceptions=True");
	expect(guidance.join("\n")).not.toMatch(/at most|ModelCallError/);
	expect(paragraph).not.toMatch(/faux|pi\.classify/);
});

test("the pi.ask paragraph is present even when no Pi tool is callable, and the system prompt never mentions it", async () => {
	h = await createHarness({ setup: enabled() });
	let prompt = "";
	const { description } = await runCell(h, "1");
	h.setResponses([(context) => {
		prompt = getSystemMessageText(context.messages.find((m) => m.role === "system")!);
		return fauxAssistantMessage("hi");
	}]);
	await h.session.prompt("hi");
	expect(description).toContain("pi.ask");
	expect(description).not.toContain("`pi`:");
	expect(prompt).not.toContain("pi.ask");
	expect(prompt).not.toContain("Model call");
});

test("pi.ask returns the configured model's answer text without thinking, sending system, maxTokens, and reasoning", async () => {
	h = await createHarness({
		fauxModels: [{ id: "faux-1" }, { id: "thinker", reasoning: true, maxTokens: 1000 }],
		setup: enabled({ model: "faux/thinker", thinking: "high", maxOutputTokens: 4096 }),
	});
	const { result, text, requests } = await runCell(
		h,
		"print(repr(await pi.ask('Classify: apple', system='Answer in one word.')))",
		() => fauxAssistantMessage([fauxThinking("it is a fruit"), fauxText("fruit")]),
	);
	expect(result.isError).toBe(false);
	expect(text).toBe("'fruit'");
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ model: "faux/thinker", system: "Answer in one word.", prompt: "Classify: apple" });
	expect(requests[0]!.options).toMatchObject({ maxTokens: 1000, reasoning: "high" });
});

test("unset modelCalls.model uses the session model: maxOutputTokens caps maxTokens and reasoning is omitted without model support", async () => {
	h = await createHarness({
		fauxModels: [{ id: "faux-1", reasoning: false, maxTokens: 16384 }, { id: "other" }],
		setup: enabled({ thinking: "high", maxOutputTokens: 256 }),
	});
	const { text, requests } = await runCell(h, "print(await pi.ask('hi'))");
	expect(text).toBe("answer: hi");
	expect(requests.map((r) => [r.model, r.system])).toEqual([["faux/faux-1", undefined]]);
	expect(requests[0]!.options?.maxTokens).toBe(256);
	expect(requests[0]!.options).not.toHaveProperty("reasoning");
});

test("the tool result's usage is the sum over the Cell's Model calls", async () => {
	h = await createHarness({ setup: enabled() });
	const one = (await runCell(h, "print(await pi.ask('same prompt'))")).result.usage!;
	const three = await runCell(h, "print(await asyncio.gather(*(pi.ask('same prompt') for _ in range(3))))");
	expect(one.totalTokens).toBeGreaterThan(0);
	expect(one.output).toBeGreaterThan(0);
	expect(three.requests).toHaveLength(3);
	const usage = three.result.usage!;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) expect(usage[key]).toBe(one[key] * 3);
	expect(usage.cost.total).toBe(one.cost.total * 3);
	// pi keeps it on the persisted tool result.
	const persisted = h.fileEntries().flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
	expect((persisted.at(-1) as ToolResultMessage).usage).toEqual(usage);
	const noCalls = await runCell(h, "1");
	expect(noCalls.result.usage).toBeUndefined();
});

test("asyncio.gather over 20 Model calls never has more than 8 in flight", async () => {
	h = await createHarness({ setup: enabled() });
	let inFlight = 0;
	let most = 0;
	const { text, requests } = await runCell(
		h,
		"rs = await asyncio.gather(*(pi.ask(f'q{i}') for i in range(20)))\nprint(len(rs), rs[0], rs[19])",
		async (request) => {
			most = Math.max(most, ++inFlight);
			await sleep(50);
			inFlight--;
			return fauxAssistantMessage(`answer: ${request.prompt}`);
		},
	);
	expect(text).toBe("20 answer: q0 answer: q19");
	expect(requests).toHaveLength(20);
	expect(most).toBe(8);
});

test("the advertised fan-out keeps answers from a budget-sized batch when another call fails", async () => {
	h = await createHarness({ setup: enabled({ maxPerCell: 2 }) });
	const { description } = await runCell(h, "1");
	const example = description.match(/`(batch = [^`]+)`[^\n]+`(rs = await asyncio\.gather\([^`]+\))`/);
	expect(example).not.toBeNull();
	const batchCode = `${example![1]}\n${example![2]}`;
	const { result, text, requests } = await runCell(h, [
		"prompts = ['a', 'b', 'c']",
		"remaining = 2",
		batchCode,
		"for p, r in zip(batch, rs):",
		"    print(p, type(r).__name__, r)",
	].join("\n"), async (request, options) => {
		if (request.prompt === "b") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" });
		await sleep(30);
		return echo(request, options);
	});
	expect(result.isError).toBe(false);
	expect(requests.map((r) => r.prompt)).toEqual(["a", "b"]);
	expect(text).toBe("a str answer: a\nb ModelCallError rate limited");
	const rest = await runCell(h, `prompts = prompts[len(batch):]\nremaining = 2\n${batchCode}\nprint(rs[0])`);
	expect(rest.text).toBe("answer: c");
	expect(rest.requests.map((r) => r.prompt)).toEqual(["c"]);
});

test("the call after maxPerCell raises before it is sent; the next Cell gets a fresh budget", async () => {
	h = await createHarness({ setup: enabled({ maxPerCell: 3 }) });
	const { text, requests } = await runCell(h, "for i in range(4):\n" + CATCH("await pi.ask(f'q{i}')").replace(/^/gm, "    "));
	expect(text.split("\n")).toEqual([
		"answer: q0",
		"answer: q1",
		"answer: q2",
		"ModelCallError: Model call limit reached: at most 3 per Cell (modelCalls.maxPerCell)",
	]);
	expect(requests.map((r) => r.prompt)).toEqual(["q0", "q1", "q2"]);
	expect((await runCell(h, "print(await pi.ask('again'))")).text).toBe("answer: again");
});

test("a provider error raises pi.ModelCallError with its text", async () => {
	h = await createHarness({ setup: enabled() });
	const { text } = await runCell(h, CATCH("await pi.ask('hi')"), () =>
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" }));
	expect(text).toBe("ModelCallError: rate limited");
});

test("pi.ask rejects truncated text without dropping its usage", async () => {
	h = await createHarness({ setup: enabled({ maxOutputTokens: 4 }) });
	const { result, text, requests } = await runCell(h, "await pi.ask('Extract a JSON name')", () =>
		fauxAssistantMessage('{"name": "', { stopReason: "length" }));
	expect(result.isError).toBe(true);
	expect(text).toContain("ModelCallError: Model answer truncated at the output limit; request a shorter answer or split the input");
	expect(text).not.toContain('{"name": "');
	expect(requests).toHaveLength(1);
	expect(result.usage?.output).toBeGreaterThan(0);
});

test.each([false, true])("an unknown chat model isn't advertised or used (usable classifier: %s)", async (classify) => {
	const notices: { message: string; type?: string }[] = [];
	h = await createHarness({
		ui: { notify: (message, type) => notices.push({ message, type }) },
		...(classify ? withClassifier({ model: "faux/nope" }) : { setup: enabled({ model: "faux/nope" }) }),
	});
	expect(notices).toEqual([{
		message: "pi-ipython config: Model faux/nope (modelCalls.model) not found; every pi.ask call will fail",
		type: "warning",
	}]);
	const code = [CATCH("await pi.ask('hi')"), ...(classify ? [`print(await pi.classify({}, ${QUESTIONS}))`] : [])];
	const { text, requests, description } = await runCell(h, code.join("\n"));
	expect(text.split("\n")).toEqual([
		"ModelCallError: Model faux/nope (modelCalls.model) not found",
		...(classify ? ["{}"] : []),
	]);
	expect(requests).toEqual([]);
	expect(description).not.toMatch(/pi\.ask|asyncio\.gather/);
	if (classify) {
		expect(description).toContain("- Model calls (`pi.classify`):");
		expect(description).toContain(CLASSIFY_SIGNATURE);
		expect(h.classifier.requests).toHaveLength(1);
	} else {
		expect(description).not.toMatch(/pi\.classify|Model calls|ModelCallError/);
	}
});

test("pi.ask using the session model is advertised only while credentials are available", async () => {
	const auth = vi.spyOn(ModelRegistry.prototype, "hasConfiguredAuth").mockReturnValue(false);
	try {
		const notices: string[] = [];
		h = await createHarness({ ui: { notify: (message) => notices.push(message) }, setup: enabled() });
		expect(notices).toEqual([
			"pi-ipython config: No credentials for faux/faux-1, the model for Model calls; every pi.ask call will fail",
		]);
		const { text, requests, description } = await runCell(h, CATCH("await pi.ask('hi')"));
		expect(text).toBe("ModelCallError: No credentials for faux/faux-1, the model for Model calls");
		expect(requests).toEqual([]);
		expect(description).not.toContain("pi.ask");
	} finally {
		auth.mockRestore();
	}
	const available = await runCell(h!, "print(await pi.ask('hi'))");
	expect(available.description).toContain("await pi.ask(");
	expect(available.text).toBe("answer: hi");
});

test("aborting a Cell during a Model call aborts the call and retains completed usage", async () => {
	h = await createHarness({ setup: enabled() });
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	let aborted = false;
	const fast: ModelReply = () => fauxAssistantMessage("A deliberately longer answer than the slow call will return.");
	const completed = (await runCell(h, "await pi.ask('fast')", fast)).result.usage!;
	expect(completed.output).toBeGreaterThan(2);
	const run = runCell(h, "await pi.ask('fast')\nx = await pi.ask('slow')", async (request, options) => {
		if (request.prompt === "fast") return fast(request, options);
		markStarted();
		await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
		aborted = options?.signal?.aborted === true;
		return fauxAssistantMessage("too late");
	});
	await started;
	await h.session.abort();
	const { result, text } = await run;
	expect(aborted).toBe(true);
	expect(result.isError).toBe(true);
	expect(text).toContain("KeyboardInterrupt");
	// The interrupted request may itself report usage before the Cell settles.
	expect(result.usage?.output).toBeGreaterThanOrEqual(completed.output);
});

test("a Kernel replacement preserves usage already gathered by the Cell", async () => {
	h = await createHarness({ setup: enabled() });
	const first = await runCell(h, "await pi.ask('fast')");
	expect(first.result.usage?.totalTokens).toBeGreaterThan(0);
	const [pid] = kernelPids();
	expect(pid).toBeDefined();
	const { result } = await runCell(h, "await pi.ask('fast')\nawait pi.ask('replace')", (request, options) => {
		if (request.prompt === "fast") return echo(request, options);
		process.kill(pid!, "SIGKILL");
		return new Promise((resolve) => {
			options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("too late")), { once: true });
		});
	});
	expect(result.isError).toBe(true);
	expect(result.usage).toEqual(first.result.usage);
});

test("a background task calling pi.ask after its Cell returned raises pi.ModelCallError and sends nothing", async () => {
	h = await createHarness({ setup: enabled() });
	const first = await runCell(h, [
		"async def late():",
		"    await asyncio.sleep(0.2)",
		"    try:",
		"        return await pi.ask('late')",
		"    except pi.ModelCallError as e:",
		"        return f'ModelCallError: {e}'",
		"background = asyncio.create_task(late())",
	].join("\n"));
	expect(first.result.isError).toBe(false);
	// No Cell is in flight while the task makes its call.
	await sleep(500);
	const later = await runCell(h, "print(background.done(), await background)");
	expect(later.text).toBe("True ModelCallError: Model calls are only allowed while their originating Cell runs");
	expect([...first.requests, ...later.requests]).toEqual([]);
});

test.each([
	[{ modelCalls: { enabled: true } }, { modelCalls: { enabled: true, maxPerCell: "bad" } }],
	[{ "modelCalls.enabled": true }, { "modelCalls.enabled": true, "modelCalls.maxPerCell": "bad" }],
])("project Model call settings %j apply only when trusted", async (valid, invalid) => {
	const notices: string[] = [];
	h = await createHarness({
		projectTrusted: false,
		ui: { notify: (message) => notices.push(message) },
		setup: (dirs) => writeConfigs(dirs, {}, invalid),
	});
	expect(notices).toEqual(['pi-ipython config: Project "modelCalls" is ignored because the project is not trusted']);
	const untrusted = await runCell(h, CATCH("await pi.ask('hi')"));
	expect(untrusted.text).toBe("ModelCallError: Model calls are turned off (modelCalls.enabled: false)");
	expect(untrusted.description).not.toContain("pi.ask");
	await h.dispose();

	h = await createHarness({ projectTrusted: true, setup: (dirs) => writeConfigs(dirs, {}, valid) });
	expect((await runCell(h, "print(await pi.ask('hi'))")).text).toBe("answer: hi");
});

test("invalid modelCalls values are reported with the file and key, and the defaults apply", async () => {
	const notices: string[] = [];
	let file = "";
	h = await createHarness({
		ui: { notify: (message) => notices.push(message) },
		setup: (dirs) => {
			file = join(dirs.agentDir, "pi-ipython.json");
			writeConfigs(dirs, {
				modelCalls: { enabled: "yes", model: "faux-1", maxPerCell: 0, maxOutputTokens: 1.5, thinking: "extreme", budget: 1 },
			});
		},
	});
	const levels = '"off", "minimal", "low", "medium", "high", "xhigh", "max"';
	expect(notices).toEqual([
		`pi-ipython config: ${file}: "modelCalls.enabled" must be true or false, got "yes"`,
		`pi-ipython config: ${file}: "modelCalls.model" must be a model as "provider/id", got "faux-1"`,
		`pi-ipython config: ${file}: "modelCalls.maxPerCell" must be a positive integer, got 0`,
		`pi-ipython config: ${file}: "modelCalls.maxOutputTokens" must be a positive integer, got 1.5`,
		`pi-ipython config: ${file}: "modelCalls.thinking" must be one of ${levels}, got "extreme"`,
		`pi-ipython config: ${file}: unknown key "modelCalls.budget"`,
	]);
	const { text } = await runCell(h, CATCH("await pi.ask('hi')"));
	expect(text).toBe("ModelCallError: Model calls are turned off (modelCalls.enabled: false)");
});

test.each([
	[{ modelCalls: true }, '"modelCalls" must be an object'],
	[{ modelCalls: { model: "/faux-1" } }, '"modelCalls.model" must be a model as "provider/id", got "/faux-1"'],
	[{ modelCalls: { model: "faux/" } }, '"modelCalls.model" must be a model as "provider/id", got "faux/"'],
	[{ modelCalls: { classifier: "judge" } }, '"modelCalls.classifier" must be a model as "provider/id", got "judge"'],
])("modelCalls config %j is reported", async (config, expected) => {
	const notices: string[] = [];
	h = await createHarness({ ui: { notify: (message) => notices.push(message) }, setup: (dirs) => writeConfigs(dirs, config) });
	expect(notices).toEqual([expect.stringContaining(expected)]);
});

test("valid modelCalls values apply: maxOutputTokens, maxPerCell, and thinking reach the calls", async () => {
	h = await createHarness({
		fauxModels: [{ id: "faux-1", reasoning: true }],
		setup: enabled({ maxPerCell: 1, maxOutputTokens: 77, thinking: "minimal" }),
	});
	const { text, requests } = await runCell(h, ["print(await pi.ask('a'))", CATCH("await pi.ask('b')")].join("\n"));
	expect(text).toBe("answer: a\nModelCallError: Model call limit reached: at most 1 per Cell (modelCalls.maxPerCell)");
	expect(requests[0]!.options).toMatchObject({ maxTokens: 77, reasoning: "minimal" });
	// Budget-based reasoning adapters may add thinking tokens up to the request model's ceiling.
	expect(requests[0]!.modelMaxTokens).toBe(77);
	expect(h.session.model?.maxTokens).toBeGreaterThan(77);
});


interface ToolUpdate {
	content: ToolResultMessage["content"];
	details?: unknown;
}

/** Record the partial results of ipython tool calls. */
function recordUpdates(harness: Harness): ToolUpdate[] {
	const updates: ToolUpdate[] = [];
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_update" && event.toolName === "ipython") updates.push(event.partialResult as ToolUpdate);
	});
	return updates;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const ui = { requestRender: () => {} } as unknown as TUI;

/** Draw each partial update, then the final result, in one tool row as interactive mode does; returns the plain text of each. */
function renderRows(harness: Harness, updates: ToolUpdate[], result: ToolResultMessage): { live: string[]; final: string } {
	const row = new ToolExecutionComponent("ipython", "call", { code: "" }, { showImages: false }, harness.session.getToolDefinition("ipython"), ui, harness.cwd);
	row.markExecutionStarted();
	row.setArgsComplete();
	const draw = () => row.render(100).map((line) => line.replace(ANSI, "").trim()).join("\n");
	const live = updates.map((u) => {
		row.updateResult({ ...u, isError: false }, true);
		return draw();
	});
	// The final result also stops the row's running timer.
	row.updateResult({ content: result.content, details: result.details, isError: result.isError });
	return { live, final: draw() };
}

/** Give every Model call reply this cost, as a priced model would; faux replies are free. */
function priceModelCalls(cost: number): void {
	const original = ModelRegistry.prototype.streamSimple;
	vi.spyOn(ModelRegistry.prototype, "streamSimple").mockImplementation(function (this: ModelRegistry, ...args) {
		const stream = original.apply(this, args);
		const result = stream.result.bind(stream);
		stream.result = async () => {
			const message = await result();
			return { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: cost } } };
		};
		return stream;
	});
}

test("a Cell without Model calls shows no Model-call line, live or final", async () => {
	h = await createHarness({ setup: enabled() });
	const updates = recordUpdates(h);
	const { result } = await runCell(h, "await asyncio.sleep(0.3)\nprint('ok')");
	expect(updates.length).toBeGreaterThan(0);
	expect(result.details).not.toHaveProperty("modelCalls");
	const { live, final } = renderRows(h, updates, result);
	expect(final).toContain("ok");
	for (const text of [...live, final]) expect(text).not.toMatch(/model call/i);
});

test.each([
	{ price: "free", cost: 0, suffix: " · $0" },
	{ price: "priced", cost: 0.01, suffix: " · $0.010" },
])("one $price Model call shows its summary live and final", async ({ cost, suffix }) => {
	if (cost) priceModelCalls(cost);
	h = await createHarness({ setup: enabled() });
	const updates = recordUpdates(h);
	const { result } = await runCell(h, "print(await pi.ask('hi'))\nawait asyncio.sleep(0.3)");
	const tokens = result.usage!.totalTokens;
	expect(tokens).toBeGreaterThan(0);
	expect(tokens).toBeLessThan(1000);
	expect(result.details).toMatchObject({ modelCalls: { count: 1, totalTokens: tokens, cost } });
	const { live, final } = renderRows(h, updates, result);
	const summary = `1 model call · ${tokens} tok${suffix}`;
	expect(final).toContain("answer: hi");
	expect(final.split("\n")).toContain(summary);
	expect(live.some((text) => text.split("\n").includes(summary) && text.includes("Running…"))).toBe(true);
});

test.each([
	{ price: "free", cost: 0, totalCost: 0, suffix: " · $0" },
	{ price: "priced", cost: 0.01, totalCost: 0.03, suffix: " · $0.030" },
])("N $price Model calls show the growing count live and the summed usage in the final result", async ({ cost, totalCost, suffix }) => {
	if (cost) priceModelCalls(cost);
	h = await createHarness({ setup: enabled() });
	const updates = recordUpdates(h);
	const long = "x".repeat(2000);
	const { result } = await runCell(h, "for i in range(3):\n    await pi.ask(f'q{i}')\nawait asyncio.sleep(0.3)", async () => {
		await sleep(150);
		return fauxAssistantMessage(long);
	});
	expect(result.usage!.cost.total).toBeCloseTo(totalCost);
	expect(result.usage!.totalTokens).toBeGreaterThan(1000);
	expect(result.details).toMatchObject({ modelCalls: { count: 3, totalTokens: result.usage!.totalTokens } });
	const { live, final } = renderRows(h, updates, result);
	const summary = final.match(/^3 model calls · \d+(?:\.\d)?k tok(.*)$/m);
	expect(summary?.[1]).toBe(suffix);
	expect(final.match(/model call/g)).toHaveLength(1);
	expect(live.some((text) => text.split("\n").includes(summary![0]) && text.includes("Running…"))).toBe(true);
	const counts = live.flatMap((text) => text.match(/^(\d) model calls? · /m)?.[1] ?? []);
	expect(new Set(counts)).toEqual(new Set(["1", "2", "3"]));
	expect(counts).toEqual([...counts].sort());
	// Cost appears live once the first reply is in.
	if (cost) expect(live.some((text) => /^\d model calls? · \S+ tok · \$0\.010$/m.test(text))).toBe(true);
});

// pi.classify: classifier Model calls, answered by the harness's faux classifier.

/** A bool, a choice, and a score question, as a Python expression. */
const QUESTIONS = `{
    "positive": {"type": "bool", "instructions": "Is the review positive?", "criteria": {"true": "Positive", "false": "Negative"}},
    "topic": {"type": "choice", "instructions": "What is it about?", "criteria": {"quality": "The product", "shipping": "The delivery"}},
    "severity": {"type": "score", "instructions": "How bad is the problem?", "criteria": ["none", "minor", "major"]},
}`;

const ANSWERS = {
	positive: { type: "bool", probability: 0.875 },
	topic: { type: "choice", choice: "shipping", probabilities: { quality: 0.25, shipping: 0.75 }, confidence: 0.5 },
	severity: { type: "score", score: 1.25, confidence: 0.625 },
} satisfies Record<string, ClassifierAnswer>;

const USAGE = {
	input: 100,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 102,
	cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
};

/** Model calls on, with the faux classifier registered and configured unless `classifier` says otherwise. */
function withClassifier(modelCalls: Record<string, unknown> = {}): HarnessOptions {
	return { fauxClassifier: {}, setup: enabled({ classifier: FAUX_CLASSIFIER, ...modelCalls }) };
}

const CLASSIFY_SIGNATURE = "- `await pi.classify(state: dict, questions: dict) -> dict`";

test("pi.classify returns the classifier's bool, choice, and score answers unchanged, sending exactly the Cell's state and questions", async () => {
	h = await createHarness(withClassifier());
	h.classifier.setReply(() => ({ answers: ANSWERS, usage: USAGE }));
	const { result, text, description, requests } = await runCell(h, [
		"print('classify' in pi.__all__)",
		`state = {"review": "Great, but it arrived late", "stars": 4, "tags": ["late", None], "meta": {"verified": True, "score": 0.5}}`,
		`answers = await pi.classify(state, ${QUESTIONS})`,
		"print(json.dumps(answers, sort_keys=True))",
	].join("\n"));
	expect(result.isError).toBe(false);
	const [exported, answers] = text.split("\n");
	expect(exported).toBe("True");
	expect(JSON.parse(answers!)).toEqual(ANSWERS);
	expect(h.classifier.requests).toEqual([{
		state: { review: "Great, but it arrived late", stars: 4, tags: ["late", null], meta: { verified: true, score: 0.5 } },
		questions: {
			positive: { type: "bool", instructions: "Is the review positive?", criteria: { true: "Positive", false: "Negative" } },
			topic: { type: "choice", instructions: "What is it about?", criteria: { quality: "The product", shipping: "The delivery" } },
			severity: { type: "score", instructions: "How bad is the problem?", criteria: ["none", "minor", "major"] },
		},
	}]);
	expect(requests).toEqual([]);
	expect(result.usage).toEqual(USAGE);
	expect(result.details).toMatchObject({ modelCalls: { count: 1, totalTokens: 102, cost: 0.0015 } });
	const lines = description.split("\n");
	const shared = lines.findIndex((line) => line.startsWith("- Model calls ("));
	const ask = lines.findIndex((line) => line.startsWith("- `await pi.ask("));
	const classify = lines.findIndex((line) => line.startsWith(CLASSIFY_SIGNATURE));
	expect(shared).toBeGreaterThanOrEqual(0);
	expect(lines[shared]).toMatch(/^- Model calls \(`pi\.ask` and `pi\.classify`\): at most 100 total per Cell, with at most 8 in flight\./);
	expect(ask).toBeGreaterThan(shared);
	expect(classify).toBeGreaterThan(ask);
	const classifierGuidance = lines.slice(classify).join("\n");
	expect(classifierGuidance).toMatch(/`bool`.*`choice`.*`score`/s);
	expect(classifierGuidance).toContain("Prefer typed answers to parsing free text");
	expect(lines.slice(ask).join("\n")).not.toMatch(/at most|ModelCallError|request a structured answer|faux-classifier|Faux Judge|\bimages\b/i);
});

test("the advertised classifier example passes a question-ID map and reads a typed answer", async () => {
	h = await createHarness(withClassifier());
	h.classifier.setReply(() => ({ answers: { positive: ANSWERS.positive } }));
	const { description } = await runCell(h, "1");
	const example = description.match(/`(a = await pi\.classify\([^`]+\))`; read `([^`]+)`/);
	expect(example).not.toBeNull();
	const { result, text } = await runCell(h, `text = 'Great!'\n${example![1]}\nprint(${example![2]})`);
	expect(result.isError).toBe(false);
	expect(text).toBe("0.875");
	expect(h.classifier.requests).toEqual([{
		state: { review: "Great!" },
		questions: {
			positive: {
				type: "bool",
				instructions: "Is the review positive?",
				criteria: { true: "Positive", false: "Not positive" },
			},
		},
	}]);
});

test("pi.ask and pi.classify share the 8-in-flight cap", async () => {
	h = await createHarness(withClassifier());
	let inFlight = 0;
	let most = 0;
	const slow = async <T>(value: T) => {
		most = Math.max(most, ++inFlight);
		await sleep(50);
		inFlight--;
		return value;
	};
	h.classifier.setReply(() => slow({ answers: { positive: ANSWERS.positive } }));
	const { text, requests } = await runCell(h, [
		"async def one(i):",
		`    return await (pi.classify({"i": i}, ${QUESTIONS}) if i % 2 else pi.ask(f"q{i}"))`,
		"rs = await asyncio.gather(*(one(i) for i in range(20)))",
		"print(len(rs), rs[0], rs[1]['positive']['probability'])",
	].join("\n"), (request) => slow(fauxAssistantMessage(`answer: ${request.prompt}`)));
	expect(text).toBe("20 answer: q0 0.875");
	expect(requests).toHaveLength(10);
	expect(h.classifier.requests).toHaveLength(10);
	expect(most).toBe(8);
});

test("pi.ask and pi.classify share maxPerCell: the call over it raises without being sent", async () => {
	h = await createHarness(withClassifier({ maxPerCell: 3 }));
	const { text, requests } = await runCell(h, [
		CATCH("await pi.ask('a')"),
		CATCH(`await pi.classify({'n': 1}, ${QUESTIONS})`),
		CATCH("await pi.ask('b')"),
		CATCH(`await pi.classify({'n': 2}, ${QUESTIONS})`),
	].join("\n"));
	expect(text.split("\n")).toEqual([
		"answer: a",
		"{}",
		"answer: b",
		"ModelCallError: Model call limit reached: at most 3 per Cell (modelCalls.maxPerCell)",
	]);
	expect(requests.map((r) => r.prompt)).toEqual(["a", "b"]);
	expect(h.classifier.requests.map((r) => r.state)).toEqual([{ n: 1 }]);
});

test("wrong pi.classify argument types raise TypeError or ValueError, send nothing, and use no budget", async () => {
	h = await createHarness(withClassifier({ maxPerCell: 1 }));
	const attempt = (call: string) => [
		"try:",
		`    await ${call}`,
		"except (TypeError, ValueError) as e:",
		"    print(type(e).__name__, e)",
	].join("\n");
	const { text } = await runCell(h, [
		attempt(`pi.classify([1], ${QUESTIONS})`),
		attempt(`pi.classify({'s': {1, 2}}, ${QUESTIONS})`),
		attempt(`pi.classify({'x': float('nan')}, ${QUESTIONS})`),
		attempt("pi.classify({'n': 1}, [])"),
		attempt("pi.classify({'n': 1}, {})"),
		attempt("pi.classify({'n': 1})"),
		`print(await pi.classify({'n': 1}, ${QUESTIONS}))`,
	].join("\n"));
	const lines = text.split("\n");
	expect(lines).toHaveLength(7);
	expect(lines[0]).toBe("TypeError state must be a dict, got list");
	expect(lines[1]).toMatch(/^TypeError state must be JSON-serializable: .*set/);
	expect(lines[2]).toMatch(/^ValueError state must be JSON-serializable: .*nan/);
	expect(lines.slice(3, 5)).toEqual(["TypeError questions must be a dict, got list", "ValueError questions must not be empty"]);
	expect(lines[5]).toMatch(/^TypeError .*questions/);
	expect(lines[6]).toBe("{}");
	expect(h.classifier.requests).toHaveLength(1);
});

test("non-JSON classifier questions raise ModelCallError without sending or using budget", async () => {
	h = await createHarness(withClassifier({ maxPerCell: 1 }));
	const { text } = await runCell(h, [
		CATCH("await pi.classify({}, {'q': {'criteria': {1, 2}}})"),
		CATCH("await pi.classify({}, {'q': {'criteria': [float('nan')]}})"),
		`print(await pi.classify({'n': 1}, ${QUESTIONS}))`,
	].join("\n"));
	const lines = text.split("\n");
	expect(lines).toHaveLength(3);
	expect(lines[0]).toMatch(/^ModelCallError: .*set/);
	expect(lines[1]).toMatch(/^ModelCallError: .*nan/);
	expect(lines[2]).toBe("{}");
	expect(h.classifier.requests.map((request) => request.state)).toEqual([{ n: 1 }]);
});

test("with modelCalls.classifier unset, pi.classify is not described and fails naming the key, without counting", async () => {
	const notices: string[] = [];
	h = await createHarness({ fauxClassifier: {}, ui: { notify: (message) => notices.push(message) }, setup: enabled({ maxPerCell: 1 }) });
	const { text, description } = await runCell(h, [CATCH(`await pi.classify({'n': 1}, ${QUESTIONS})`), CATCH("await pi.ask('hi')")].join("\n"));
	expect(text.split("\n")).toEqual([
		"ModelCallError: No classifier is set for Model calls (modelCalls.classifier)",
		"answer: hi",
	]);
	expect(h.classifier.requests).toEqual([]);
	expect(notices).toEqual([]);
	expect(description).not.toContain("pi.classify");
	expect(description).toContain("- Model calls (`pi.ask`): at most 1 total per Cell, with at most 8 in flight.");
});

test.each([
	{
		problem: "not found",
		classifier: "faux/faux-1", // A chat model exists with this exact ID, but no classifier does.
		apiKey: "faux",
		error: "Classifier faux/faux-1 (modelCalls.classifier) not found",
	},
	{
		problem: "without credentials",
		classifier: FAUX_CLASSIFIER,
		apiKey: "$PI_IPYTHON_TEST_MISSING_CLASSIFIER_KEY",
		error: `No credentials for ${FAUX_CLASSIFIER}, the classifier for Model calls`,
	},
])("a classifier $problem warns at start, is not described, and every pi.classify call fails", async ({ classifier, apiKey, error }) => {
	vi.stubEnv("PI_IPYTHON_TEST_MISSING_CLASSIFIER_KEY", undefined);
	const notices: { message: string; type?: string }[] = [];
	h = await createHarness({
		...withClassifier({ classifier }),
		fauxClassifier: { apiKey },
		ui: { notify: (message, type) => notices.push({ message, type }) },
	});
	expect(notices).toEqual([{ message: `pi-ipython config: ${error}; every pi.classify call will fail`, type: "warning" }]);
	const { text, description } = await runCell(h, [CATCH(`await pi.classify({'n': 1}, ${QUESTIONS})`), CATCH("await pi.ask('hi')")].join("\n"));
	expect(text.split("\n")).toEqual([`ModelCallError: ${error}`, "answer: hi"]);
	expect(h.classifier.requests).toEqual([]);
	expect(description).toContain("pi.ask");
	expect(description).not.toContain("pi.classify");
});

test("a project modelCalls.classifier applies only when the project is trusted", async () => {
	const setup: HarnessOptions["setup"] = (dirs) => writeConfigs(dirs, { modelCalls: { enabled: true } }, { modelCalls: { classifier: FAUX_CLASSIFIER } });
	const call = CATCH(`await pi.classify({'n': 1}, ${QUESTIONS})`);
	h = await createHarness({ fauxClassifier: {}, projectTrusted: false, setup });
	const untrusted = await runCell(h, call);
	expect(untrusted.text).toBe("ModelCallError: No classifier is set for Model calls (modelCalls.classifier)");
	expect(untrusted.description).not.toContain("pi.classify");
	expect(h.classifier.requests).toEqual([]);
	await h.dispose();

	h = await createHarness({ fauxClassifier: {}, projectTrusted: true, setup });
	const trusted = await runCell(h, call);
	expect(trusted.text).toBe("{}");
	expect(trusted.description).toContain(CLASSIFY_SIGNATURE);
	expect(h.classifier.requests).toHaveLength(1);
});

test("modelCalls.enabled false makes pi.classify fail and leaves it undescribed", async () => {
	h = await createHarness({ fauxClassifier: {}, setup: (dirs) => writeConfigs(dirs, { modelCalls: { classifier: FAUX_CLASSIFIER } }) });
	const { text, description } = await runCell(h, CATCH(`await pi.classify({'n': 1}, ${QUESTIONS})`));
	expect(text).toBe("ModelCallError: Model calls are turned off (modelCalls.enabled: false)");
	expect(description).not.toContain("pi.classify");
	expect(h.classifier.requests).toEqual([]);
});

test.each(["error", "aborted"] as const)("a classifier result with stopReason %s raises pi.ModelCallError with its text, and its usage still counts", async (stopReason) => {
	h = await createHarness(withClassifier());
	h.classifier.setReply(() => ({ stopReason, errorMessage: "classifier overloaded", usage: USAGE }));
	const { result, text } = await runCell(h, CATCH(`await pi.classify({'n': 1}, ${QUESTIONS})`));
	expect(text).toBe("ModelCallError: classifier overloaded");
	expect(result.usage).toEqual(USAGE);
	expect(result.details).toMatchObject({ modelCalls: { count: 1, totalTokens: 102 } });
});

test("a classifier result without usage counts in the Model-call line with 0 tok and $0", async () => {
	h = await createHarness(withClassifier());
	h.classifier.setReply(() => ({ answers: { positive: ANSWERS.positive } }));
	const updates = recordUpdates(h);
	const { result, text } = await runCell(h, `print(await pi.classify({'n': 1}, ${QUESTIONS}))`);
	expect(text).toBe("{'positive': {'type': 'bool', 'probability': 0.875}}");
	expect(result.usage).toBeUndefined();
	expect(result.details).toMatchObject({ modelCalls: { count: 1, totalTokens: 0, cost: 0 } });
	expect(renderRows(h, updates, result).final.split("\n")).toContain("1 model call · 0 tok · $0");
});

test("aborting a Cell aborts its pi.classify call in flight", async () => {
	h = await createHarness(withClassifier());
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	let aborted = false;
	h.classifier.setReply(async (_context, options) => {
		markStarted();
		await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
		aborted = options?.signal?.aborted === true;
		return { stopReason: "aborted" };
	});
	const run = runCell(h, `x = await pi.classify({'n': 1}, ${QUESTIONS})`);
	await started;
	await h.session.abort();
	const { result, text } = await run;
	expect(aborted).toBe(true);
	expect(result.isError).toBe(true);
	expect(text).toContain("KeyboardInterrupt");
});

test("a background task calling pi.classify after its Cell returned raises pi.ModelCallError and sends nothing", async () => {
	h = await createHarness(withClassifier());
	const first = await runCell(h, [
		"async def late():",
		"    await asyncio.sleep(0.2)",
		"    try:",
		`        return await pi.classify({'n': 1}, ${QUESTIONS})`,
		"    except pi.ModelCallError as e:",
		"        return f'ModelCallError: {e}'",
		"background = asyncio.create_task(late())",
	].join("\n"));
	expect(first.result.isError).toBe(false);
	await sleep(500);
	const later = await runCell(h, "print(background.done(), await background)");
	expect(later.text).toBe("True ModelCallError: Model calls are only allowed while their originating Cell runs");
	expect(h.classifier.requests).toEqual([]);
});


const IMAGE_FORMATS = ["png", "jpeg", "webp", "gif"];

test("classifier detects mixed paths and bytes from content, using the Kernel's changed cwd", async () => {
	h = await createHarness({ ...withClassifier(), fauxClassifier: { input: ["text", "image"] } });
	const dir = join(h.cwd, "images");
	await mkdir(dir);
	const images = await Promise.all(IMAGE_FORMATS.map(async (format, i) => {
		const bytes = await readFile(new URL(`./fixtures/classifier/pixel.${format}`, import.meta.url));
		// Misleading suffix: the content, not the extension, determines MIME type.
		await writeFile(join(dir, `${i}.txt`), bytes);
		return { type: "image", data: bytes.toString("base64"), mimeType: `image/${format}` };
	}));
	const { result, text, description } = await runCell(h, [
		"from pathlib import Path",
		`os.chdir(${JSON.stringify(dir)})`,
		"payloads = [Path(f'{i}.txt').read_bytes() for i in range(4)]",
		"paths = ['0.txt', Path('1.txt'), '2.txt', Path('3.txt')]",
		"raw = [payloads[0], bytearray(payloads[1]), memoryview(payloads[2]), payloads[3]]",
		`print(await pi.classify({}, ${QUESTIONS}, images=paths + raw))`,
	].join("\n"));
	expect(result.isError).toBe(false);
	expect(text).toBe("{}");
	expect(h.classifier.requests[0]!.images).toEqual([...images, ...images]);
	expect(result.details).toMatchObject({ modelCalls: { count: 1 } });
	expect(description).toContain("questions: dict, *, images=None)");
	expect(description).toContain("a list of paths or bytes; PNG/JPEG/WebP/GIF");
	expect(description).not.toMatch(/PIL.Image|Faux Judge|faux-classifier/);
});

test("image preparation errors send nothing and spend no budget or TUI count", async () => {
	h = await createHarness({ ...withClassifier({ maxPerCell: 1 }), fauxClassifier: { input: ["text", "image"] } });
	const badFile = join(h.cwd, "bad.png");
	await writeFile(badFile, "not an image");
	const { result, text } = await runCell(h, [
		CATCH(`await pi.classify({}, ${QUESTIONS}, images=[${JSON.stringify(badFile)}])`),
		CATCH(`await pi.classify({}, ${QUESTIONS}, images=[b'not an image'])`),
		CATCH(`await pi.classify({}, ${QUESTIONS}, images=[${JSON.stringify(join(h.cwd, "missing.png"))}])`),
		CATCH(`await pi.classify({}, ${QUESTIONS}, images=[${JSON.stringify(h.cwd)}])`),
	].join("\n"));
	expect(result.isError).toBe(false);
	expect(text.match(/ModelCallError:/g)).toHaveLength(4);
	expect(text.match(/Unsupported image format/g)).toHaveLength(2);
	expect(h.classifier.requests).toEqual([]);
	expect(result.details).not.toHaveProperty("modelCalls");
	const next = await runCell(h, [
		CATCH(`await pi.classify({}, ${QUESTIONS}, images=[b'bad'])`),
		`print(await pi.classify({}, ${QUESTIONS}, images=[]))`,
	].join("\n"));
	expect(next.text).toMatch(/Unsupported image format.*\n\{\}/s);
	expect(h.classifier.requests).toHaveLength(1);
	expect(next.result.details).toMatchObject({ modelCalls: { count: 1, totalTokens: 0, cost: 0 } });
});

test("text-only classifier rejects images before counting and omits image guidance", async () => {
	h = await createHarness(withClassifier({ maxPerCell: 1 }));
	const { result, text, description } = await runCell(h, [
		CATCH(`await pi.classify({}, ${QUESTIONS}, images=[b'anything'])`),
		`print(await pi.classify({}, ${QUESTIONS}, images=None))`,
	].join("\n"));
	expect(text).toBe("ModelCallError: Classifier does not accept image input\n{}");
	expect(description).toContain(CLASSIFY_SIGNATURE);
	expect(description).not.toMatch(/images=|paths or bytes|PNG\/JPEG/);
	expect(h.classifier.requests).toHaveLength(1);
	expect(result.details).toMatchObject({ modelCalls: { count: 1 } });
});

test("invalid images arguments raise TypeError locally without spending budget", async () => {
	h = await createHarness(withClassifier({ maxPerCell: 1 }));
	const invalid = ["'a.png'", "b'abc'", "()", "{}", "[1]", "[None]", "[object()]", "['ok.png', []]"];
	const { result, text } = await runCell(h, [
		...invalid.map((value) => [
			"try:",
			`    await pi.classify({}, ${QUESTIONS}, images=${value})`,
			"except TypeError as e:",
			"    print(type(e).__name__)",
		].join("\n")),
		`print(await pi.classify({}, ${QUESTIONS}))`,
	].join("\n"));
	expect(result.isError).toBe(false);
	expect(text.split("\n")).toEqual([...invalid.map(() => "TypeError"), "{}"]);
	expect(h.classifier.requests).toHaveLength(1);
	expect(result.details).toMatchObject({ modelCalls: { count: 1 } });
});
