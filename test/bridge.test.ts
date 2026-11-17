import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_PYTHON_VERSION, kernelVenvDir, venvPython } from "../src/kernel/bootstrap.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";

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
			const python = venvPython(kernelVenvDir(DEFAULT_PYTHON_VERSION));
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
