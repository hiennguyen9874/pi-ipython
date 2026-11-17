import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getSystemMessageText } from "@earendil-works/pi-ai";
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
});

test("the prompt explains pi discovery without listing any Pi tool", async () => {
	h = await createHarness({
		extensions: [
			(pi) => pi.registerTool({
				name: "frobnicate",
				label: "frobnicate",
				description: "Frobnicate a widget.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			}),
		],
	});
	const prompt = await providerSystemPrompt(h);

	expect(prompt).toContain("await pi.tool(");
	expect(prompt).toContain("await pi.tools()");
	expect(prompt).toContain("await pi.describe(");
	expect(prompt).not.toContain("frobnicate");
});
