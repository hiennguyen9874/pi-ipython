import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import {
	createCodemodeExtension,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { venvPython } from "../src/kernel/bootstrap.ts";
import { createHarness, defaultKernelVenv, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Pi tools for Cells to call: direct and codemode exposure, structured, image, throwing, and hook-blocked ones. */
const piTools: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Echo text back.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo: ${text}` }], details: {} }),
	});
	pi.registerTool({
		name: "stats",
		label: "stats",
		description: "Count items.",
		exposure: "codemode",
		promptGuidelines: ["Call stats before listing items."],
		parameters: Type.Object({}),
		outputSchema: Type.Object({ count: Type.Number(), names: Type.Array(Type.String()) }),
		execute: async () => ({
			content: [{ type: "text", text: "2 items" }],
			structuredContent: { count: 2, names: ["a", "b"] },
			details: {},
		}),
	});
	pi.registerTool({
		name: "snapshot",
		label: "snapshot",
		description: "Take screenshots.",
		exposure: "codemode",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [
				{ type: "text", text: "two frames" },
				{ type: "image", data: PNG, mimeType: "image/png" },
				{ type: "image", data: PNG, mimeType: "image/png" },
			],
			details: {},
		}),
	});
	pi.registerTool({
		name: "explode",
		label: "explode",
		description: "Always fails.",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("kaboom");
		},
	});
	pi.registerTool({
		name: "guarded",
		label: "guarded",
		description: "Blocked by a hook.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "guarded ran" }], details: {} }),
	});
	pi.registerTool({
		name: "mcp__docs__lookup",
		label: "lookup",
		description: "Look up a doc page.\nPass the page slug; returns markdown.",
		exposure: "codemode",
		namespace: { name: "mcp__docs", aliases: ["docs"], description: "Docs server.", instructions: "Pass slugs, not titles." },
		parameters: Type.Object({ slug: Type.String({ description: "Page slug" }) }),
		execute: async (_id, { slug }) => ({ content: [{ type: "text", text: `# ${slug}` }], details: {} }),
	});
	pi.on("tool_call", (event) => (event.toolName === "guarded" ? { block: true, reason: "guarded is blocked by policy" } : undefined));
};

const extensions = [piTools, createCodemodeExtension()];

test("a Cell calls direct and codemode-exposure Pi tools, getting text and structured results", async () => {
	h = await createHarness({ extensions });
	const [r] = await h.runCells("(await pi.tool('echo', {'text': 'hi'}), await pi.tool('stats'), await pi.tool('stats', {}))");
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("('echo: hi', {'count': 2, 'names': ['a', 'b']}, {'count': 2, 'names': ['a', 'b']})");
});

test("the provider request declares only ipython, while bridged direct tools stay callable", async () => {
	h = await createHarness({ extensions });
	const declared: string[][] = [];
	const seeTools = (context: Context) => declared.push(getCurrentTools(context.messages).map((t) => t.name));
	h.setResponses([
		(context: Context) => {
			seeTools(context);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "await pi.tool('echo', {'text': 'x'})" }), { stopReason: "toolUse" });
		},
		(context: Context) => {
			seeTools(context);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("go");
	expect(declared).toEqual([["ipython"], ["ipython"]]);
	const result = h.session.messages.find((m) => m.role === "toolResult");
	expect(result && resultText(result)).toBe("'echo: x'");
});

test("blocked, unknown, invalid, excluded, and throwing calls raise pi.ToolError", async () => {
	h = await createHarness({ extensions });
	const [r] = await h.runCells(
		[
			"async def err(name, args=None):",
			"    try:",
			"        await pi.tool(name, args)",
			"    except pi.ToolError as e:",
			"        return f'{type(e).__module__}.{type(e).__name__} {isinstance(e, RuntimeError)}: {e}'",
			"    return 'no error'",
			"for name, args in [('guarded', {}), ('nope', {}), ('echo', {}), ('read', {'path': 'x'}), ('codemode', {'code': '1'}), ('ipython', {'code': '1'}), ('explode', {})]:",
			"    print(name, '->', await err(name, args))",
		].join("\n"),
	);
	const lines = resultText(r!).split("\n");
	expect(lines[0]).toBe("guarded -> pi.ToolError True: guarded is blocked by policy");
	expect(lines[1]).toBe("nope -> pi.ToolError True: Tool nope not found");
	expect(lines[2]).toMatch(/^echo -> pi\.ToolError True: Validation failed for tool "echo"/);
	expect(lines.slice(-4)).toEqual([
		"read -> pi.ToolError True: Tool read not found",
		"codemode -> pi.ToolError True: Tool codemode not found",
		"ipython -> pi.ToolError True: Tool ipython not found",
		"explode -> pi.ToolError True: kaboom",
	]);
});

test("a failed call carries structuredContent as pi.ToolError.result only for tools with an output schema", async () => {
	const failure = { code: 404, missing: ["a"] };
	const failingTools: ExtensionFactory = (pi) => {
		for (const name of ["reject", "loose_reject"]) {
			pi.registerTool({
				name,
				label: name,
				description: "Fail with a structured result.",
				parameters: Type.Object({ text: Type.String() }),
				...(name === "reject" ? { outputSchema: Type.Object({ code: Type.Number(), missing: Type.Array(Type.String()) }) } : {}),
				execute: async () => ({
					content: [{ type: "text", text: `${name} failed` }],
					structuredContent: failure,
					isError: true,
					details: {},
				}),
			});
		}
		pi.on("tool_call", (event) => (event.toolName === "reject" && event.input.text === "block" ? { block: true, reason: "reject is blocked" } : undefined));
	};
	h = await createHarness({ extensions: [...extensions, failingTools] });
	const [r] = await h.runCells([
		"import json",
		"for name, args in [('reject', {'text': 'x'}), ('loose_reject', {'text': 'x'}), ('reject', {'text': 'block'}), ('reject', {}), ('nope', {})]:",
		"    try:",
		"        await pi.tool(name, args)",
		"        print(name, 'no error')",
		"    except pi.ToolError as e:",
		"        print(name, json.dumps(e.result), str(e).split(chr(10))[0])",
		"print(await pi.tool('stats'))",
	].join("\n"));
	expect(r?.isError).toBe(false);
	const lines = resultText(r!).split("\n");
	expect(lines.slice(0, 3)).toEqual([
		`reject ${JSON.stringify(failure).replaceAll(",", ", ").replaceAll(":", ": ")} reject failed`,
		"loose_reject null loose_reject failed",
		"reject null reject is blocked",
	]);
	expect(lines[3]).toMatch(/^reject null Validation failed for tool "reject"/);
	expect(lines.slice(4)).toEqual(["nope null Tool nope not found", "{'count': 2, 'names': ['a', 'b']}"]);
});

test("structured successes preserve JSON values and failed calls carry only dicts", async () => {
	const valueSchema = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.String()), Type.Record(Type.String(), Type.Number())]);
	h = await createHarness({
		extensions: [(pi) => pi.registerTool({
			name: "structured",
			label: "structured",
			description: "Return a JSON value, successfully or as a failure.",
			parameters: Type.Object({ value: valueSchema, fail: Type.Boolean() }),
			outputSchema: valueSchema,
			execute: async (_id, { value, fail }) => ({
				content: [{ type: "text", text: "fallback" }],
				structuredContent: value,
				isError: fail,
				details: {},
			}),
		})],
	});
	const [r] = await h.runCells([
		"for value in [None, False, 0, '', [], {}]:",
		"    print('ok', repr(await pi.tool('structured', {'value': value, 'fail': False})))",
		"    try:",
		"        await pi.tool('structured', {'value': value, 'fail': True})",
		"    except pi.ToolError as e:",
		"        print('error', repr(e.result), str(e))",
	].join("\n"));
	expect(r?.isError).toBe(false);
	expect(resultText(r!).split("\n")).toEqual([
		"ok None", "error None fallback",
		"ok False", "error None fallback",
		"ok 0", "error None fallback",
		"ok ''", "error None fallback",
		"ok []", "error None fallback",
		"ok {}", "error {} fallback",
	]);
});

test.each(["finished", "missing"])("a background call with a %s originating Cell cannot borrow a later Cell's context", async (origin) => {
	const called: string[] = [];
	const observeCalls: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			if (event.toolName === "echo") called.push(event.toolName);
		});
	};
	h = await createHarness({ extensions: [...extensions, observeCalls] });
	const [, stale, current] = await h.runCells(
		[
			"import contextvars",
			"gate = asyncio.Event()",
			"async def late():",
			"    await gate.wait()",
			"    try:",
			"        return await pi.tool('echo', {'text': 'stale'})",
			"    except pi.ToolError as e:",
			"        return f'ToolError {e.result}: {e}'",
			`background = asyncio.create_task(late()${origin === "missing" ? ", context=contextvars.Context()" : ""})`,
		].join("\n"),
		"gate.set()\nprint(await background)",
		"print(await asyncio.gather(pi.tool('echo', {'text': 'one'}), pi.tool('echo', {'text': 'two'})))",
	);
	expect(stale?.isError).toBe(false);
	expect(resultText(stale!)).toBe("ToolError None: Bridged calls are only allowed while their originating Cell runs");
	expect(current?.isError).toBe(false);
	expect(resultText(current!)).toBe("['echo: one', 'echo: two']");
	expect(called).toEqual(["echo", "echo"]);
});

test("pi.tools() lists the callable set live, with first description lines and namespaces", async () => {
	let api: ExtensionAPI | undefined;
	h = await createHarness({ extensions: [...extensions, (pi) => void (api = pi)] });
	const listing = "print(sorted((t['name'], t['description'], t['namespace']) for t in await pi.tools()))";
	const [before] = await h.runCells(listing);
	expect(resultText(before!)).toBe(
		"[('echo', 'Echo text back.', None), ('explode', 'Always fails.', None), ('guarded', 'Blocked by a hook.', None), "
			+ "('mcp__docs__lookup', 'Look up a doc page.', 'mcp__docs'), ('snapshot', 'Take screenshots.', None), ('stats', 'Count items.', None)]",
	);
	api!.registerTool({
		name: "late",
		label: "late",
		description: "Registered after the Kernel started.",
		exposure: "codemode",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "late ran" }], details: {} }),
	});
	const [after, called] = await h.runCells("print([t['name'] for t in await pi.tools() if t['name'] == 'late'])", "await pi.tool('late')");
	expect(resultText(after!)).toBe("['late']");
	expect(resultText(called!)).toBe("'late ran'");
});

test("a direct tool registered during a Cell is discoverable and callable immediately, with its declaration hidden", async () => {
	const registerLate: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "register_late",
			label: "register late",
			description: "Register an initially inactive direct tool.",
			exposure: "codemode",
			parameters: Type.Object({}),
			execute: async () => {
				pi.registerTool({
					name: "late_direct",
					label: "late direct",
					description: "Registered during a Cell.",
					exposure: "direct",
					defaultActive: false,
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "late direct ran" }], details: {} }),
				});
				return { content: [{ type: "text", text: "registered" }], details: {} };
			},
		});
	};
	h = await createHarness({ extensions: [...extensions, registerLate] });
	const declared: string[][] = [];
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", {
			code: [
				"await pi.tool('register_late')",
				"print([t['name'] for t in await pi.tools() if t['name'] == 'late_direct'])",
				"print((await pi.describe('late_direct'))['description'])",
				"print(await pi.tool('late_direct'))",
			].join("\n"),
		}), { stopReason: "toolUse" }),
		(context: Context) => {
			declared.push(getCurrentTools(context.messages).map((t) => t.name));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("register and call a tool in one Cell");
	const result = h.session.messages.find((m) => m.role === "toolResult");
	expect(result && resultText(result)).toBe("['late_direct']\nRegistered during a Cell.\nlate direct ran");
	expect(declared).toEqual([["ipython"]]);
});

test("pi.describe() returns the full description and schema; unknown and excluded names raise pi.ToolError", async () => {
	h = await createHarness({ extensions });
	const [described, errors] = await h.runCells(
		"import json\nd = await pi.describe('mcp__docs__lookup')\nprint(json.dumps(d, sort_keys=True))",
		[
			"for name in ['nope', 'read', 'codemode', 'ipython']:",
			"    try:",
			"        await pi.describe(name)",
			"        print(name, 'no error')",
			"    except pi.ToolError as e:",
			"        print(name, '->', e)",
		].join("\n"),
	);
	expect(JSON.parse(resultText(described!))).toEqual({
		name: "mcp__docs__lookup",
		description: "Look up a doc page.\nPass the page slug; returns markdown.",
		namespace: "mcp__docs",
		parameters: {
			type: "object",
			properties: { slug: { type: "string", description: "Page slug" } },
			required: ["slug"],
		},
		guidelines: [],
		returns: "str",
	});
	expect(resultText(errors!).split("\n")).toEqual([
		"nope -> Tool nope not found",
		"read -> Tool read not found",
		"codemode -> Tool codemode not found",
		"ipython -> Tool ipython not found",
	]);
});

test("pi.describe() returns a tool's guidelines and output schema", async () => {
	h = await createHarness({ extensions });
	const [r] = await h.runCells("import json\nd = await pi.describe('stats')\nprint(json.dumps([d['guidelines'], d['returns']]))");
	const [guidelines, returns] = JSON.parse(resultText(r!));
	expect(guidelines).toEqual(["Call stats before listing items."]);
	expect(returns).toMatchObject({
		type: "object",
		properties: { count: { type: "number" }, names: { type: "array", items: { type: "string" } } },
		required: ["count", "names"],
	});
});

test("pi.describe_namespace() describes a callable tool's namespace by name or alias; unknown names raise pi.ToolError", async () => {
	h = await createHarness({ extensions });
	const [r] = await h.runCells([
		"import json",
		"print(json.dumps(await pi.describe_namespace('mcp__docs'), sort_keys=True))",
		"print((await pi.describe_namespace('docs'))['name'])",
		"for name in ['nope', 'mcp__docs__lookup']:",
		"    try:",
		"        await pi.describe_namespace(name)",
		"        print(name, 'no error')",
		"    except pi.ToolError as e:",
		"        print(name, '->', e)",
	].join("\n"));
	const lines = resultText(r!).split("\n");
	expect(JSON.parse(lines[0]!)).toEqual({ name: "mcp__docs", description: "Docs server.", instructions: "Pass slugs, not titles." });
	expect(lines.slice(1)).toEqual([
		"mcp__docs",
		"nope -> Namespace nope not found",
		"mcp__docs__lookup -> Namespace mcp__docs__lookup not found",
	]);
});

test("pi.search() ranks callable tools by description words and name, capped by limit; bad queries raise", async () => {
	h = await createHarness({ extensions });
	const [r] = await h.runCells([
		"import json",
		"print(json.dumps(await pi.search('screenshots')))",
		"print([t['name'] for t in await pi.search('page slug markdown')])",
		"print([t['name'] for t in await pi.search('lookup')])",
		"print(len(await pi.search('echo count screenshots fails blocked', limit=2)))",
		"print(await pi.search('zzz unmatched'))",
		"print([t['name'] for t in await pi.search('read file')])",
		"for args in [('',), ('   ',), (None,), (3,), ('echo', 0), ('echo', True)]:",
		"    try:",
		"        await pi.search(*args)",
		"        print(args, 'no error')",
		"    except (TypeError, ValueError) as e:",
		"        print(type(e).__name__, e)",
	].join("\n"));
	expect(r?.isError).toBe(false);
	const [first, ...lines] = resultText(r!).split("\n");
	expect(JSON.parse(first!)).toEqual([{ name: "snapshot", description: "Take screenshots.", namespace: null }]);
	expect(lines).toEqual([
		"['mcp__docs__lookup']",
		"['mcp__docs__lookup']",
		"2",
		"[]",
		// Excluded tools (pi's built-in read) are never ranked.
		"[]",
		"TypeError query must be a non-empty str",
		"TypeError query must be a non-empty str",
		"TypeError query must be a non-empty str",
		"TypeError query must be a non-empty str",
		"ValueError limit must be positive",
		"TypeError limit must be an int, got bool",
	]);
});

test("pi.search() ranks a full tool name above a higher-scoring namespace suffix, even with limit=1", async () => {
	const competingTools: ExtensionFactory = (pi) => {
		for (const name of ["echo", "mcp__docs__echo"]) {
			pi.registerTool({
				name,
				label: name,
				description: "Echo text back.",
				namespace: name === "echo" ? undefined : { name: "mcp__docs", description: "echo" },
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
			});
		}
	};
	h = await createHarness({ extensions: [competingTools] });
	const [r] = await h.runCells([
		"print([t['name'] for t in await pi.search('echo')])",
		"print([t['name'] for t in await pi.search('echo', limit=1)])",
		"print([t['name'] for t in await pi.search('mcp__docs__echo', limit=1)])",
	].join("\n"));
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("['echo', 'mcp__docs__echo']\n['echo']\n['mcp__docs__echo']");
});

test("pi.search(namespace=) ranks only that namespace's tools, by name or alias, then applies limit", async () => {
	const twoServers: ExtensionFactory = (pi) => {
		for (const [server, alias, tools] of [["mcp__docs", "docs", ["fetch", "fetch_page"]], ["mcp__web", "web", ["fetch", "fetch_url"]]] as const) {
			for (const tool of tools) {
				pi.registerTool({
					name: `${server}__${tool}`,
					label: tool,
					description: "Fetch a document.",
					exposure: "deferred",
					namespace: { name: server, aliases: [alias] },
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			}
		}
		pi.registerTool({
			name: "fetch",
			label: "fetch",
			description: "Fetch a document.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	};
	h = await createHarness({ extensions: [twoServers] });
	const [r] = await h.runCells([
		"names = lambda ts: sorted(t['name'] for t in ts)",
		"print(names(await pi.search('fetch document')))",
		"print(names(await pi.search('fetch document', namespace='mcp__docs')))",
		"print(names(await pi.search('fetch document', namespace='web')))",
		"print(len(await pi.search('fetch document', limit=1, namespace='mcp__web')), (await pi.search('fetch', limit=1, namespace='web'))[0]['namespace'])",
		"print(await pi.search('zzz', namespace='docs'))",
		"for ns in ['nope', 'mcp__docs__fetch', '']:",
		"    try:",
		"        await pi.search('fetch', namespace=ns)",
		"        print(repr(ns), 'no error')",
		"    except pi.ToolError as e:",
		"        print('ToolError', e)",
		"    except (TypeError, ValueError) as e:",
		"        print(type(e).__name__, e)",
		"try:",
		"    await pi.search('fetch', namespace=3)",
		"except TypeError as e:",
		"    print('TypeError', e)",
	].join("\n"));
	expect(r?.isError).toBe(false);
	expect(resultText(r!).split("\n")).toEqual([
		"['fetch', 'mcp__docs__fetch', 'mcp__docs__fetch_page', 'mcp__web__fetch', 'mcp__web__fetch_url']",
		"['mcp__docs__fetch', 'mcp__docs__fetch_page']",
		"['mcp__web__fetch', 'mcp__web__fetch_url']",
		"1 mcp__web",
		"[]",
		"ToolError Namespace nope not found",
		"ToolError Namespace mcp__docs__fetch not found",
		"TypeError namespace must be a non-empty str or None",
		"TypeError namespace must be a non-empty str or None, got int",
	]);
});

test("pi.search() raises pi.ToolError when piTools.search is false", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ piTools: { search: false } }));
		},
		extensions,
	});
	const [r] = await h.runCells([
		"try:",
		"    await pi.search('echo')",
		"except pi.ToolError as e:",
		"    print('ToolError:', e)",
		"print(len(await pi.tools()) > 0)",
	].join("\n"));
	expect(resultText(r!)).toBe("ToolError: pi.search is turned off (piTools.search: false)\nTrue");
});

test("a result with images returns its text plus the omitted-images marker", async () => {
	h = await createHarness({ extensions });
	const [r] = await h.runCells("print(await pi.tool('snapshot'))");
	expect(resultText(r!)).toBe("two frames\n[2 image(s) omitted]");
	expect(r?.content.some((block) => block.type === "image")).toBe(false);
});

test("pi exists in a new Kernel and after a Kernel replacement", async () => {
	h = await createHarness({ extensions });
	const [first, crashed, next] = await h.runCells(
		"await pi.tool('echo', {'text': 'one'})",
		"import os\nos._exit(3)",
		"await pi.tool('echo', {'text': 'two'})",
	);
	expect(resultText(first!)).toBe("'echo: one'");
	expect(crashed?.isError).toBe(true);
	expect(resultText(next!)).toBe("'echo: two'");
});

// A shell script stands in for the project venv's Python, running the test Kernel venv's.
test.skipIf(process.platform === "win32")("pi exists with python.source: project", async () => {
	h = await createHarness({
		extensions,
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".venv", "bin"), { recursive: true });
			const python = venvPython(defaultKernelVenv());
			writeFileSync(join(cwd, ".venv", "bin", "python"), `#!/bin/sh\nexec '${python}' "$@"\n`, { mode: 0o755 });
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ python: { source: "project" } }));
		},
	});
	const [r] = await h.runCells("await pi.tool('echo', {'text': 'project'})");
	expect(resultText(r!)).toBe("'echo: project'");
});

test("pi is left out of the Python-state notice", async () => {
	h = await createHarness({ extensions });
	await h.runCells("a = 1");
	h.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
	h.setResponses([fauxAssistantMessage("Summary."), fauxAssistantMessage("Turn prefix summary.")]);
	await h.session.compact();
	let seen = "";
	h.setResponses([
		(context: Context) => {
			seen = JSON.stringify(context.messages);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("continue");
	expect(seen).toContain("These names are still defined: a.");
});

/** A Pi tool that waits `ms` (or until aborted) and records each run: started, then how it ended. */
function slowTool() {
	const runs: { text: string; ended?: "done" | "aborted" }[] = [];
	let notifyStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => (notifyStarted = resolve));
	const factory: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "slow",
			label: "slow",
			description: "Wait, then echo.",
			parameters: Type.Object({ text: Type.String(), ms: Type.Number() }),
			execute: async (_id, { text, ms }, signal) => {
				const run: (typeof runs)[number] = { text };
				runs.push(run);
				notifyStarted();
				try {
					await sleep(ms, undefined, { signal });
				} catch (error) {
					run.ended = "aborted";
					throw error;
				}
				run.ended = "done";
				return { content: [{ type: "text", text: `slow: ${text}` }], details: {} };
			},
		});
	};
	return { runs, started, factory };
}

test("aborting a Cell blocked on a slow Pi tool aborts the tool, and the Kernel keeps Python state", async () => {
	const slow = slowTool();
	h = await createHarness({ extensions: [...extensions, slow.factory] });
	await h.runCells("x = 41");
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code: "await pi.tool('slow', {'text': 'never', 'ms': 3600000})" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const before = h.session.messages.length;
	const run = h.session.prompt("call the slow tool");
	await slow.started;
	await h.session.abort();
	await run;
	const aborted = h.session.messages.slice(before).find((m) => m.role === "toolResult");
	expect(slow.runs).toEqual([{ text: "never", ended: "aborted" }]);
	expect(aborted?.isError).toBe(true);
	expect(aborted && resultText(aborted)).toContain("KeyboardInterrupt");

	const [next] = await h.runCells("x + 1");
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("42");
});

test("a background task calling pi.tool after its Cell returned gets pi.ToolError and the tool never runs", async () => {
	const slow = slowTool();
	h = await createHarness({ extensions: [...extensions, slow.factory] });
	const [first] = await h.runCells(
		[
			"async def late():",
			"    await asyncio.sleep(0.2)",
			"    try:",
			"        return await pi.tool('slow', {'text': 'late', 'ms': 0})",
			"    except pi.ToolError as e:",
			"        return f'ToolError: {e}'",
			"background = asyncio.create_task(late())",
		].join("\n"),
	);
	expect(first?.isError).toBe(false);
	// No Cell is in flight while the task makes its call.
	await sleep(500);
	const [later] = await h.runCells("print(background.done(), await background)");
	expect(resultText(later!)).toBe("True ToolError: Bridged calls are only allowed while their originating Cell runs");
	expect(slow.runs).toEqual([]);
});

test("concurrent Bridged calls in one Cell each return their own result, even when they finish out of order", async () => {
	const slow = slowTool();
	h = await createHarness({ extensions: [...extensions, slow.factory] });
	const [r] = await h.runCells(
		"print(await asyncio.gather(pi.tool('slow', {'text': 'first', 'ms': 300}), pi.tool('slow', {'text': 'second', 'ms': 0}), pi.tool('echo', {'text': 'third'})))",
	);
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("['slow: first', 'slow: second', 'echo: third']");
	expect(slow.runs.map((run) => run.text)).toEqual(["first", "second"]);
});

test("with confirmEachCell on, a Cell making Bridged calls asks once, not per call", async () => {
	const prompts: string[] = [];
	const ui: Partial<ExtensionUIContext> = {
		confirm: async (_title, message) => {
			prompts.push(message);
			return true;
		},
	};
	h = await createHarness({
		extensions,
		ui,
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ confirmEachCell: true }));
		},
	});
	const code = "(await pi.tool('echo', {'text': 'a'}), await pi.tool('stats'), await asyncio.gather(pi.tool('echo', {'text': 'b'}), pi.tool('echo', {'text': 'c'})))";
	const [r] = await h.runCells(code);
	expect(resultText(r!)).toBe("('echo: a', {'count': 2, 'names': ['a', 'b']}, ['echo: b', 'echo: c'])");
	expect(prompts).toEqual([code]);
});
