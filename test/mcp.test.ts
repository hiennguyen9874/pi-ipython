import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createCodemodeExtension, createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, resultText } from "./harness.ts";

const server = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

function writeConfig(agentDir: string, exposure: string, gate?: string): void {
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
		autoEnableCodemode: false,
		mcpServers: {
			docs: {
				command: process.execPath,
				args: [server, ...(gate ? [gate] : [])],
				exposure,
				toolExposure: { hidden: "hidden" },
			},
		},
	}));
}

test.each(["direct", "codemode", "deferred"])("builtin:mcp tools with %s exposure are discoverable, callable, guarded, and not declared", async (exposure) => {
	const guards: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => event.toolName === "mcp__docs__guarded"
			? { block: true, reason: "blocked by policy" }
			: undefined);
	};
	h = await createHarness({
		setup: ({ agentDir }) => writeConfig(agentDir, exposure),
		extensions: [guards, createCodemodeExtension(), { name: "mcp", builtin: true, factory: createMcpExtension() }],
	});
	const declared: string[][] = [];
	h.setResponses([
		(context: Context) => {
			declared.push(getCurrentTools(context.messages).map((t) => t.name));
			return fauxAssistantMessage(fauxToolCall("ipython", { code: [
				"import json",
				"print(json.dumps(await pi.tools(), sort_keys=True))",
				"print((await pi.describe('mcp__docs__echo'))['parameters']['required'])",
				"print(json.dumps(await pi.describe_namespace('mcp__docs'), sort_keys=True))",
				"print((await pi.tool('mcp__docs__echo', {'text': 'hi'}))['content'][0]['text'])",
				"print([t['name'] for t in await pi.search('mcp__docs__echo')][0], [t['name'] for t in await pi.search('hidden')])",
				"try:",
				"    await pi.tool('mcp__docs__echo', {'text': 'fail'})",
				"except pi.ToolError as e:",
				"    print(json.dumps(e.result, sort_keys=True), e)",
				"for name in ['mcp__docs__hidden', 'read', 'codemode', 'mcp__docs__guarded']:",
				"    try:",
				"        await pi.tool(name, {'text': 'no'})",
				"    except pi.ToolError as e:",
				"        print(name, '->', e, e.result)",
			].join("\n") }), { stopReason: "toolUse" });
		},
		(context: Context) => {
			declared.push(getCurrentTools(context.messages).map((t) => t.name));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("discover and call MCP tools");
	const result = h.session.messages.find((m) => m.role === "toolResult");
	expect(result?.isError).toBe(false);
	const lines = resultText(result!).split("\n");
	expect(JSON.parse(lines[0]!)).toEqual([
		{ name: "mcp__docs__echo", description: "Docs echo.", namespace: "mcp__docs" },
		{ name: "mcp__docs__guarded", description: "Docs guarded.", namespace: "mcp__docs" },
	]);
	expect(JSON.parse(lines[2]!)).toEqual({
		name: "mcp__docs",
		// pi's MCP extension sets a namespace description only from the server's configured description.
		description: null,
		instructions: "Docs server.\nSearch before you look up a page.",
	});
	expect([lines[1], ...lines.slice(3)]).toEqual([
		"['text']",
		"docs: hi",
		// Found by name; the hidden tool is not callable, so it is never ranked.
		"mcp__docs__echo []",
		// pi's MCP extension returns the whole CallToolResult as structured content.
		'{"content": [{"text": "docs: page not found", "type": "text"}], "isError": true, "structuredContent": {"code": 404}} docs: page not found',
		"mcp__docs__hidden -> Tool mcp__docs__hidden not found None",
		"read -> Tool read not found None",
		"codemode -> Tool codemode not found None",
		"mcp__docs__guarded -> blocked by policy None",
	]);
	expect(declared).toEqual([["ipython"], ["ipython"]]);
	expect(h.session.getAllTools().find((t) => t.name === "mcp__docs__echo")?.sourceInfo).toMatchObject({
		source: "builtin", path: "builtin:mcp",
	});
});

test("MCP resource tools are found and callable from a Cell, and do not reach hidden servers", async () => {
	h = await createHarness({
		setup: ({ agentDir }) => writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
			autoEnableCodemode: false,
			mcpServers: {
				// Default exposure (codemode), which MCP registers as deferred.
				docs: { command: process.execPath, args: [server, "--resources"] },
				secret: { command: process.execPath, args: [server, "--resources"], exposure: "hidden" },
			},
		})),
		extensions: [{ name: "mcp", builtin: true, factory: createMcpExtension() }],
	});
	const descriptions: string[] = [];
	h.setResponses([
		(context: Context) => {
			descriptions.push(getCurrentTools(context.messages).find((t) => t.name === "ipython")!.description);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: [
				"import json",
				"print(sorted(t['name'] for t in await pi.tools()))",
				"print([t['name'] for t in await pi.search('read mcp resource', limit=1)])",
				"listing = await pi.tool('list_mcp_resources', {})",
				"print(json.dumps(listing, sort_keys=True))",
				"page = await pi.tool('read_mcp_resource', {'server': 'docs', 'uri': listing['resources'][0]['uri']})",
				"print(json.dumps(page, sort_keys=True))",
				"try:",
				"    await pi.tool('read_mcp_resource', {'server': 'secret', 'uri': 'docs://pages/intro'})",
				"except pi.ToolError as e:",
				"    print(e, e.result)",
			].join("\n") }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("read MCP resources");
	const result = h.session.messages.find((m) => m.role === "toolResult");
	expect(result?.isError).toBe(false);
	const lines = resultText(result!).split("\n");
	expect(lines[0]).toBe("['list_mcp_resource_templates', 'list_mcp_resources', 'mcp__docs__echo', 'mcp__docs__guarded', 'mcp__docs__hidden', 'read_mcp_resource']");
	expect(lines[1]).toBe("['read_mcp_resource']");
	expect(JSON.parse(lines[2]!)).toEqual({
		resources: [{ server: "docs", uri: "docs://pages/intro", name: "intro", mimeType: "text/markdown" }],
	});
	expect(JSON.parse(lines[3]!)).toEqual({
		server: "docs",
		uri: "docs://pages/intro",
		contents: [{ uri: "docs://pages/intro", mimeType: "text/markdown", text: "# Intro (docs://pages/intro)" }],
	});
	expect(lines.slice(4)).toEqual(['MCP server "secret" has no resources. Servers with resources: docs None']);
	// Deferred like their servers' tools, so the ipython description does not list them.
	expect(descriptions[0]).not.toContain("mcp_resource");
});

test("MCP resource tools are absent when only a hidden server has resources", async () => {
	h = await createHarness({
		setup: ({ agentDir }) => writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
			autoEnableCodemode: false,
			mcpServers: {
				docs: { command: process.execPath, args: [server] },
				secret: { command: process.execPath, args: [server, "--resources"], exposure: "hidden" },
			},
		})),
		extensions: [{ name: "mcp", builtin: true, factory: createMcpExtension() }],
	});
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code: [
			"print(sorted(t['name'] for t in await pi.tools()))",
			"try:",
			"    await pi.tool('list_mcp_resources', {})",
			"except pi.ToolError as e:",
			"    print(e)",
		].join("\n") }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("read MCP resources");
	const result = h.session.messages.find((m) => m.role === "toolResult");
	expect(result?.isError).toBe(false);
	expect(resultText(result!).split("\n")).toEqual([
		"['mcp__docs__echo', 'mcp__docs__guarded', 'mcp__docs__hidden']",
		"Tool list_mcp_resources not found",
	]);
});

test.each(["direct", "codemode", "deferred"])("the pi section follows delayed %s MCP registration and the first Cell waits for readiness", async (exposure) => {
	let gate: string;
	let registeredBeforeCell = false;
	const mcp: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			if (event.toolName === "ipython") writeFileSync(gate, "ready");
		});
		// A gated direct server must not hold up the first model request either.
		createMcpExtension({ startupWaitMs: 0 })(pi);
		// This handler runs after the real MCP readiness handler, but before Cell execution.
		pi.on("tool_call", (event) => {
			if (event.toolName === "ipython") {
				registeredBeforeCell = pi.getAllTools().some((t) => t.name === "mcp__docs__echo");
			}
		});
	};
	h = await createHarness({
		setup: ({ agentDir }) => {
			gate = join(agentDir, "mcp-ready");
			writeConfig(agentDir, exposure, gate);
		},
		extensions: [{ name: "mcp", builtin: true, factory: mcp }],
	});
	const prompts: string[] = [];
	const descriptions: string[] = [];
	const record = (context: Context) => {
		prompts.push(getSystemMessageText(context.messages.find((m) => m.role === "system")!));
		descriptions.push(getCurrentTools(context.messages).find((t) => t.name === "ipython")!.description);
	};
	h.setResponses([
		(context) => {
			// No tools are registered yet: do not advertise the pi API.
			expect(h!.session.getAllTools().some((t) => t.name === "mcp__docs__echo")).toBe(false);
			record(context);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "print([t['name'] for t in await pi.tools()])" }), { stopReason: "toolUse" });
		},
		(context) => {
			record(context);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("discover tools");
	const r = h.session.messages.find((m) => m.role === "toolResult");
	expect(descriptions).toHaveLength(2);
	expect(descriptions[0]).not.toContain("await pi.");
	expect(descriptions[1]).toContain("await pi.tools()");
	// The prompt is fixed for the run and never mentions pi.
	expect(prompts[1]).toBe(prompts[0]);
	expect(prompts[0]).not.toContain("await pi.");
	expect(registeredBeforeCell).toBe(true);
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("['mcp__docs__echo', 'mcp__docs__guarded']");
});
