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
				"for name in ['mcp__docs__hidden', 'read', 'codemode', 'mcp__docs__guarded']:",
				"    try:",
				"        await pi.tool(name, {'text': 'no'})",
				"    except pi.ToolError as e:",
				"        print(name, '->', e)",
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
		"mcp__docs__hidden -> Tool mcp__docs__hidden not found",
		"read -> Tool read not found",
		"codemode -> Tool codemode not found",
		"mcp__docs__guarded -> blocked by policy",
	]);
	expect(declared).toEqual([["ipython"], ["ipython"]]);
	expect(h.session.getAllTools().find((t) => t.name === "mcp__docs__echo")?.sourceInfo).toMatchObject({
		source: "builtin", path: "builtin:mcp",
	});
});

test.each(["direct", "codemode", "deferred"])("the pi prompt follows delayed %s MCP registration and the first Cell waits for readiness", async (exposure) => {
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
	h.setResponses([
		(context) => {
			// No tools are registered yet: do not advertise the pi API.
			expect(h!.session.getAllTools().some((t) => t.name === "mcp__docs__echo")).toBe(false);
			prompts.push(getSystemMessageText(context.messages.find((m) => m.role === "system")!));
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "print([t['name'] for t in await pi.tools()])" }), { stopReason: "toolUse" });
		},
		(context) => {
			prompts.push(getSystemMessageText(context.messages.find((m) => m.role === "system")!));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("discover tools");
	const r = h.session.messages.find((m) => m.role === "toolResult");
	expect(prompts).toHaveLength(2);
	expect(prompts[0]).not.toContain("await pi.");
	expect(prompts[1]).toContain("await pi.tools()");
	expect(prompts[1]).not.toContain("mcp__docs__echo");
	expect(registeredBeforeCell).toBe(true);
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("['mcp__docs__echo', 'mcp__docs__guarded']");
});
