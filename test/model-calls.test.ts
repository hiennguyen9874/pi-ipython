import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import {
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
import { createHarness, type Harness, type HarnessOptions, kernelPids, resultText, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
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
	expect(paragraph.startsWith("- `await pi.ask(prompt: str, *, system: str | None = None) -> str`")).toBe(true);
	expect(paragraph).toContain("semantically dense pieces of data");
	expect(paragraph).toContain("asyncio.gather");
	expect(paragraph).toContain("at most 8 run at once, and a Cell may make at most 7 calls");
	expect(paragraph).toContain("pi.ModelCallError");
	expect(paragraph).not.toContain("faux");
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

test("an unknown modelCalls.model warns at start and every call raises without falling back to the session model", async () => {
	const notices: { message: string; type?: string }[] = [];
	h = await createHarness({
		ui: { notify: (message, type) => notices.push({ message, type }) },
		setup: enabled({ model: "faux/nope" }),
	});
	expect(notices).toEqual([{
		message: "pi-ipython config: Model faux/nope (modelCalls.model) not found; every Model call will fail",
		type: "warning",
	}]);
	const { text, requests } = await runCell(h, CATCH("await pi.ask('hi')"));
	expect(text).toBe("ModelCallError: Model faux/nope (modelCalls.model) not found");
	expect(requests).toEqual([]);
});

test("Model calls using the session model warn at startup and reject when credentials are missing", async () => {
	const auth = vi.spyOn(ModelRegistry.prototype, "hasConfiguredAuth").mockReturnValue(false);
	try {
		const notices: string[] = [];
		h = await createHarness({ ui: { notify: (message) => notices.push(message) }, setup: enabled() });
		expect(notices).toEqual([
			"pi-ipython config: No credentials for faux/faux-1, the model for Model calls; every Model call will fail",
		]);
		const { text, requests } = await runCell(h, CATCH("await pi.ask('hi')"));
		expect(text).toBe("ModelCallError: No credentials for faux/faux-1, the model for Model calls");
		expect(requests).toEqual([]);
	} finally {
		auth.mockRestore();
	}
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
	{ price: "free", cost: 0, suffix: "" },
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
	{ price: "free", cost: 0, totalCost: 0, suffix: "" },
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
