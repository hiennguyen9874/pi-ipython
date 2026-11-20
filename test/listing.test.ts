import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, resultText } from "./harness.ts";

const server = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const LIST_INTRO = "Pi tools you can call from Python";
/** Where the `pi` API section starts, right after the registered description. */
const PI_SECTION = "\n\n- `pi`: the session's other tools";

function tool(name: string, description: string, extra: Record<string, unknown> = {}) {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name} ran` }], details: {} }),
		...extra,
	};
}

/** A direct, a codemode, and a deferred Pi tool. */
const exposures: ExtensionFactory = (pi) => {
	pi.registerTool(tool("echo", "Echo text back.\nSecond line stays out of the list."));
	pi.registerTool(tool("stats", "Count items.", {
		exposure: "codemode",
		namespace: { name: "data", description: "Data helpers." },
	}));
	pi.registerTool(tool("archive", "Search the archive.", { exposure: "deferred" }));
};

/** pi's MCP extension with the test server; default (deferred) exposure unless given. */
function writeMcpConfig(agentDir: string, gate?: string, exposure?: string): void {
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
		autoEnableCodemode: false,
		mcpServers: { docs: { command: process.execPath, args: [server, ...(gate ? [gate] : [])], ...(exposure ? { exposure } : {}) } },
	}));
}

/** MCP whose server lists its tools only once the first Cell is called. */
function gatedMcp(gate: () => string): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			if (event.toolName === "ipython") writeFileSync(gate(), "ready");
		});
		createMcpExtension({ startupWaitMs: 0 })(pi);
	};
}

/** The `ipython` description in each provider request of one prompt that runs `code` in a Cell. */
async function descriptionsSeen(harness: Harness, code = "1"): Promise<string[]> {
	const seen: string[] = [];
	const describe = (context: Context) => {
		seen.push(getCurrentTools(context.messages).find((t) => t.name === "ipython")!.description);
	};
	harness.setResponses([
		(context: Context) => {
			describe(context);
			return fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });
		},
		(context: Context) => {
			describe(context);
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("go");
	return seen;
}

/** The description the tool registers, i.e. the description without a tool list. */
function baseDescription(harness: Harness): string {
	return harness.session.getAllTools().find((t) => t.name === "ipython")!.description;
}

test("direct and codemode tools are listed by namespace after the pi section; deferred and default MCP tools are not, and MCP registration leaves it unchanged", async () => {
	let gate = "";
	h = await createHarness({
		setup: ({ agentDir }) => {
			gate = join(agentDir, "mcp-ready");
			writeMcpConfig(agentDir, gate);
		},
		extensions: [exposures, { name: "mcp", builtin: true, factory: gatedMcp(() => gate) }],
	});
	const [before, after] = await descriptionsSeen(h, "print(sorted(t['name'] for t in await pi.tools()))");
	expect(before.startsWith(`${baseDescription(h)}${PI_SECTION}`)).toBe(true);
	expect(before.endsWith([
		"Pi tools you can call from Python with `await pi.tool(name, args)`; `await pi.describe(name)` shows a tool's parameters. This list may be incomplete: `await pi.tools()` lists every callable tool.",
		"- `echo`: Echo text back.",
		"## data\nData helpers.\n- `stats`: Count items.",
	].join("\n\n"))).toBe(true);
	expect(after).toBe(before);
	// The MCP tools registered during the Cell and are callable, just not listed.
	const result = h.session.messages.find((m) => m.role === "toolResult");
	expect(resultText(result!)).toBe("['archive', 'echo', 'mcp__docs__echo', 'mcp__docs__guarded', 'mcp__docs__hidden', 'stats']");
});

test.each(["codemode", "deferred"])("MCP tools with %s exposure (deferred Pi tools) get the pi section but are not listed", async (exposure) => {
	h = await createHarness({
		setup: ({ agentDir }) => writeMcpConfig(agentDir, undefined, exposure),
		extensions: [{ name: "mcp", builtin: true, factory: createMcpExtension() }],
	});
	const seen = await descriptionsSeen(h, "print(len(await pi.tools()))");
	expect(seen[1]!.startsWith(`${baseDescription(h)}${PI_SECTION}`)).toBe(true);
	for (const description of seen) {
		expect(description).not.toContain(LIST_INTRO);
		expect(description).not.toContain("mcp__docs");
	}
	expect(resultText(h.session.messages.find((m) => m.role === "toolResult")!)).toBe("3");
});

test("MCP tools with direct exposure are listed under their server's namespace", async () => {
	h = await createHarness({
		setup: ({ agentDir }) => writeMcpConfig(agentDir, undefined, "direct"),
		extensions: [{ name: "mcp", builtin: true, factory: createMcpExtension() }],
	});
	const [description] = await descriptionsSeen(h);
	expect(description).toContain("## mcp__docs\n- `mcp__docs__echo`: Docs echo.\n- `mcp__docs__hidden`: Docs hidden.\n- `mcp__docs__guarded`: Docs guarded.");
});

test("tools over the 3000-token budget are dropped round-robin and their namespace is marked", async () => {
	// 30 tools of ~250 tokens per namespace: each namespace gets about the same share of the budget.
	const filler = "x".repeat(1000);
	const many: ExtensionFactory = (pi) => {
		pi.registerTool(tool("plain", "No namespace."));
		for (const ns of ["alpha", "beta"]) {
			for (let i = 0; i < 30; i++) {
				pi.registerTool(tool(`${ns}_${String(i).padStart(2, "0")}`, `${ns} ${filler}`, {
					exposure: "codemode",
					namespace: { name: ns },
				}));
			}
		}
		// A single tool larger than the whole budget.
		pi.registerTool(tool("huge", "y".repeat(13_000), { exposure: "codemode", namespace: { name: "gamma", description: "Big." } }));
	};
	h = await createHarness({ extensions: [many] });
	const [description] = await descriptionsSeen(h);
	const listed = (ns: string) => description!.match(new RegExp(`- \`${ns}_\\d+\``, "g"))?.length ?? 0;
	expect(description).toContain("- `plain`: No namespace.");
	expect(description).toContain("## alpha (some tools not listed)\n- `alpha_");
	expect(description).toContain("## beta (some tools not listed)\n- `beta_");
	expect(description).toContain("## gamma (tools not listed)\nBig.");
	expect(description).not.toContain("- `huge`");
	expect(listed("alpha")).toBeGreaterThan(0);
	expect(Math.abs(listed("alpha") - listed("beta"))).toBeLessThanOrEqual(1);
	expect(listed("alpha") + listed("beta")).toBeLessThan(60);
	// The listed lines stay within the budget of 3000 estimated tokens (4 chars per token).
	const list = description!.slice(description!.indexOf(LIST_INTRO));
	const lines = list.split("\n").filter((line) => line.startsWith("- `"));
	expect(lines.reduce((sum, line) => sum + Math.ceil(line.length / 4), 0)).toBeLessThanOrEqual(3000);
});

test("piTools.list false leaves the list out and keeps the pi section", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ piTools: { list: false } }));
		},
		extensions: [exposures],
	});
	const [description] = await descriptionsSeen(h);
	expect(description!.startsWith(`${baseDescription(h)}${PI_SECTION}`)).toBe(true);
	expect(description).not.toContain(LIST_INTRO);
});

test("an invalid piTools.list is reported and the list stays on", async () => {
	const notices: string[] = [];
	let file = "";
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: ({ agentDir }) => {
			file = join(agentDir, "pi-ipython.json");
			writeFileSync(file, JSON.stringify({ piTools: { list: "no", other: 1 } }));
		},
		extensions: [exposures],
	});
	expect(notices).toEqual([
		`pi-ipython config: ${file}: "piTools.list" must be true or false, got "no"`,
		`pi-ipython config: ${file}: unknown key "piTools.other"`,
	]);
	const [description] = await descriptionsSeen(h);
	expect(description).toContain("- `echo`: Echo text back.");
});

test("with no callable Pi tools the description has no list", async () => {
	h = await createHarness();
	const seen = await descriptionsSeen(h);
	expect(seen).toEqual([baseDescription(h), baseDescription(h)]);
	expect(seen[0]).not.toContain(LIST_INTRO);
});

test("with only deferred MCP tools the description gains the pi section once they register, and no list", async () => {
	let gate = "";
	h = await createHarness({
		setup: ({ agentDir }) => {
			gate = join(agentDir, "mcp-ready");
			writeMcpConfig(agentDir, gate);
		},
		extensions: [{ name: "mcp", builtin: true, factory: gatedMcp(() => gate) }],
	});
	const seen = await descriptionsSeen(h, "print(len(await pi.tools()))");
	expect(seen[0]).toBe(baseDescription(h));
	expect(seen[1]!.startsWith(`${baseDescription(h)}${PI_SECTION}`)).toBe(true);
	expect(seen[1]).not.toContain(LIST_INTRO);
	expect(resultText(h.session.messages.find((m) => m.role === "toolResult")!)).toBe("3");
});
