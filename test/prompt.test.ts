import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ToolExposure } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

/** Run one turn and return the system prompt the provider received. */
async function providerSystemPrompt(harness: Harness): Promise<string> {
	let prompt: string | undefined;
	harness.setResponses([
		(context) => {
			const system = context.messages.find((m) => m.role === "system");
			prompt = system ? getSystemMessageText(system) : "";
			return fauxAssistantMessage("ok");
		},
	]);
	await harness.session.prompt("hi");
	return prompt ?? "";
}

function localDate(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("the provider receives the REPL prompt with context files, skills, cwd, and date", async () => {
	let skillPath = "";
	h = await createHarness({
		setup: ({ cwd, agentDir }) => {
			writeFileSync(join(cwd, "AGENTS.md"), "Always answer in haiku.\n");
			const skillDir = join(agentDir, "skills", "csv-tricks");
			mkdirSync(skillDir, { recursive: true });
			skillPath = join(skillDir, "SKILL.md");
			writeFileSync(skillPath, "---\nname: csv-tricks\ndescription: Parse CSV files fast.\n---\nUse pandas.\n");
		},
	});
	const prompt = await providerSystemPrompt(h);

	expect(prompt.startsWith("You have one tool, `ipython`")).toBe(true);
	expect(prompt).not.toContain("running inside pi");
	expect(prompt).toContain("Always answer in haiku.");
	expect(prompt).toContain(join(h.cwd, "AGENTS.md"));
	expect(prompt).toContain("csv-tricks");
	expect(prompt).toContain(skillPath);
	expect(prompt).toContain(`Working directory: ${h.cwd}`);
	expect(prompt).toContain(`Current date: ${localDate()}`);
});

test("the prompt names no tool other than ipython and warns against magics and !cmd", async () => {
	h = await createHarness();
	const prompt = await providerSystemPrompt(h);

	for (const tool of ["read", "write", "edit", "grep", "find", "ls", "codemode"]) {
		expect(prompt).not.toMatch(new RegExp(`\\b${tool} tool\\b|\`${tool}\``));
	}
	expect(prompt).toContain("%magic");
	expect(prompt).toContain("!cmd");
	expect(prompt).not.toContain("`pi`");
	expect(prompt).not.toContain("await pi.");
	// Baseline from a858d6f, before #33; only the date and temporary cwd vary.
	const baseline = readFileSync(new URL("./fixtures/no-pi-tools-prompt.txt", import.meta.url), "utf8")
		.replace("{{DATE}}", localDate())
		.replace("{{CWD}}", h.cwd.replace(/\\/g, "/"));
	expect(prompt).toBe(baseline);
	expect(prompt).toContain("`bash(command:");
	expect(prompt).toContain("## Rules");
});

test.each(["direct", "codemode", "deferred"] as const)("the prompt explains pi discovery for %s tools without listing any Pi tool", async (exposure) => {
	h = await createHarness({
		extensions: [
			(pi) => pi.registerTool({
				name: "frobnicate",
				label: "frobnicate",
				description: "Frobnicate a widget.",
				exposure,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			}),
		],
	});
	const prompt = await providerSystemPrompt(h);

	expect(prompt).toContain("await pi.tool(");
	expect(prompt).toContain("await pi.tools()");
	expect(prompt).toContain("await pi.describe(");
	// Only inside the pi section, which ends where the rules begin.
	const piSection = prompt.slice(prompt.indexOf("- `pi`:"), prompt.indexOf("## Rules"));
	expect(piSection).toContain("Before first using a tool, call `await pi.describe(name)` to read its schema, guidelines, and returns.");
	expect(piSection).toContain("await pi.describe_namespace(name)");
	expect(prompt.split("describe_namespace")).toHaveLength(2);
	expect(piSection).toContain("await pi.search(query: str, limit: int = 8, namespace: str | None = None)");
	expect(prompt.split("pi.search")).toHaveLength(2);
	expect(prompt).not.toContain("frobnicate");
});

test("piTools.search false leaves pi.search out of the prompt and keeps the rest of the pi section", async () => {
	const frobnicate = (pi: ExtensionAPI) => pi.registerTool({
		name: "frobnicate",
		label: "frobnicate",
		description: "Frobnicate a widget.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	});
	h = await createHarness({ extensions: [frobnicate] });
	const on = await providerSystemPrompt(h);
	await h.dispose();
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ piTools: { search: false } }));
		},
		extensions: [frobnicate],
	});
	const off = await providerSystemPrompt(h);
	expect(off).not.toContain("search(");
	expect(off).toContain("await pi.tools()");
	const searchLine = on.split("\n").find((line) => line.includes("pi.search"))!;
	// Same prompt otherwise; only the temporary cwd differs.
	const cwdLine = (prompt: string) => prompt.replace(/Working directory: .*/, "");
	expect(cwdLine(on).replace(`${searchLine}\n`, "")).toBe(cwdLine(off));
});

test("excluded tools do not enable the pi section", async () => {
	h = await createHarness({
		extensions: [(pi) => {
			for (const exposure of ["hidden", "model-only"] as const) {
				pi.registerTool({
					name: exposure,
					label: exposure,
					description: "Unavailable to Cells.",
					exposure,
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				});
			}
			pi.registerTool({
				name: "dispatcher",
				label: "dispatcher",
				description: "Reaches other tools.",
				reachesTools: () => "all",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			});
		}],
	});
	expect(h.session.getAllTools().some((tool) => tool.sourceInfo.source === "builtin")).toBe(true);
	const prompt = await providerSystemPrompt(h);
	expect(prompt).not.toContain("await pi.");
});

test("the pi section follows tools added and hidden between runs", async () => {
	let api!: ExtensionAPI;
	h = await createHarness({ extensions: [(pi) => { api = pi; }] });
	const register = (exposure: ToolExposure) => api.registerTool({
		name: "late",
		label: "late",
		description: "Registered after session startup.",
		exposure,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	});
	expect(await providerSystemPrompt(h)).not.toContain("await pi.");
	register("codemode");
	expect(await providerSystemPrompt(h)).toContain("await pi.tools()");
	register("hidden");
	expect(await providerSystemPrompt(h)).not.toContain("await pi.");
});

test("tools registered by a later before_agent_start handler appear in the first request", async () => {
	h = await createHarness({
		extensions: [(pi) => {
			pi.on("before_agent_start", async () => {
				await Promise.resolve();
				pi.registerTool({
					name: "late_startup",
					label: "late",
					description: "Registered by a later startup handler.",
					exposure: "codemode",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				});
			});
		}],
	});
	expect(await providerSystemPrompt(h)).toContain("await pi.tools()");
});

test("the pi section follows the live callable set within one run", async () => {
	let api!: ExtensionAPI;
	const register = (exposure: ToolExposure) => api.registerTool({
		name: "toggle",
		label: "toggle",
		description: "Hide this Pi tool.",
		exposure,
		parameters: Type.Object({}),
		execute: async () => {
			register("hidden");
			return { content: [], details: {} };
		},
	});
	h = await createHarness({
		extensions: [(pi) => {
			api = pi;
			register("codemode");
		}],
	});
	const prompts: string[] = [];
	h.setResponses([
		(context) => {
			prompts.push(getSystemMessageText(context.messages.find((m) => m.role === "system")!));
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "await pi.tool('toggle')" }), { stopReason: "toolUse" });
		},
		(context) => {
			prompts.push(getSystemMessageText(context.messages.find((m) => m.role === "system")!));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("hide the tool");
	expect(prompts).toHaveLength(2);
	expect(prompts[0]).toContain("await pi.tools()");
	expect(prompts[1]).not.toContain("await pi.");
});
