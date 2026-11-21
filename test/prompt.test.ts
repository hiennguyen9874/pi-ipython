import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ToolExposure } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { Type } from "typebox";
import { createHarness, type Harness, resultText, systemPrompt, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

interface ProviderRequest {
	prompt: string;
	/** The `ipython` description. */
	description: string;
	parameters?: object;
}

function seen(context: Context): ProviderRequest {
	const system = context.messages.find((m) => m.role === "system");
	const tool = getCurrentTools(context.messages).find((t) => t.name === "ipython");
	return {
		prompt: system ? getSystemMessageText(system) : "",
		description: tool?.description ?? "",
		parameters: tool?.parameters,
	};
}

/** Run a Cell and return the system prompt and `ipython` metadata the provider received. */
async function providerRequest(harness: Harness): Promise<ProviderRequest> {
	let request: ProviderRequest | undefined;
	harness.setResponses([
		(context) => {
			request = seen(context);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "print('prompt check')" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("ok"),
	]);
	const before = harness.session.messages.length;
	await harness.session.prompt("hi");
	const result = harness.session.messages.slice(before).find((message) => message.role === "toolResult");
	expect(result?.isError).toBe(false);
	expect(resultText(result!)).toBe("prompt check");
	return request!;
}

/** The `pi` section of the `ipython` description, or undefined without one. */
function piSection(description: string): string | undefined {
	const start = description.indexOf("- `pi`:");
	if (start < 0) return undefined;
	const end = description.indexOf("\n\n", start);
	return description.slice(start, end < 0 ? undefined : end);
}

/** The content of a `<name>` section of the prompt. */
function section(prompt: string, name: string): string {
	const open = `<${name}>\n`;
	const start = prompt.indexOf(open);
	expect(start).toBeGreaterThanOrEqual(0);
	return prompt.slice(start + open.length, prompt.indexOf(`\n</${name}>`, start));
}

test("pi's prompt gets an ipython section before docs and the skills list before cwd", async () => {
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
	const { prompt } = await providerRequest(h);

	expect(prompt.startsWith("You are a coding assistant running inside pi")).toBe(true);
	const order = ["<tools>", "<rules>", "<ipython>\nYou have one tool, `ipython`", "<docs>", "<project_context>", "<skills>", "<cwd>"]
		.map((marker) => prompt.indexOf(marker));
	expect(order.every((index) => index >= 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	expect(prompt).toContain("Always answer in haiku.");
	expect(prompt).toContain(join(h.cwd, "AGENTS.md"));
	const skills = prompt.slice(prompt.indexOf("<skills>"), prompt.indexOf("</skills>"));
	expect(skills).toContain("csv-tricks");
	expect(skills).toContain(skillPath);
	expect(skills).toContain("open(location).read()");
	expect(prompt).toContain(`<cwd>\n${h.cwd.replace(/\\/g, "/")}\n</cwd>`);
	expect(prompt).not.toContain("Current date");
});

test("the prompt names no tool other than ipython and warns against magics and !cmd", async () => {
	h = await createHarness();
	const { prompt } = await providerRequest(h);

	for (const tool of ["read", "write", "edit", "grep", "find", "ls", "codemode"]) {
		expect(prompt).not.toMatch(new RegExp(`\\b${tool} tool\\b|\`${tool}\``));
	}
	expect(prompt).toContain("%magic");
	expect(prompt).toContain("!cmd");
	expect(prompt).not.toContain("`pi`");
	expect(prompt).not.toContain("await pi.");
	// pi's own tool list and rules know only ipython; the rules for read/bash/edit/write are gone.
	expect(section(prompt, "tools")).toBe("- ipython: ipython - persistent Python Kernel for code, data, and state\n\nAdditional tools may be available.");
	expect(section(prompt, "rules")).not.toContain("Use bash");
	// Pin the default ipython section without optional Background-command guidance.
	const baseline = readFileSync(new URL("./fixtures/no-pi-tools-prompt.txt", import.meta.url), "utf8");
	expect(`${section(prompt, "ipython")}\n`).toBe(baseline);
});

const PARALLEL_RULES = [
	"\n- Start independent commands together, then collect them: `hs = [bash(c) for c in cmds]; rs = [await h for h in hs]`.\n",
	"\n- Wait by awaiting a handle, never with `sleep` or polling loops.\n",
	"\n- The user cannot redirect you while a Cell runs. If independent work remains, do not `await` a long command; keep its handle and check it in a later Cell.\n",
];
const NOTICE_RULE = "\n- A command that outlives its Cell sends a Background-command notice (`[bash-done …]`)";

test.each([false, true])("the parallel-work rules are in the prompt with backgroundNotices %s, before any [bash-done …] rule", async (notices) => {
	h = await createHarness({
		mode: "rpc",
		setup: (dirs) => writeConfigs(dirs, { backgroundNotices: notices }),
	});
	const ipython = section((await providerRequest(h)).prompt, "ipython");
	const shell = ipython.slice(ipython.indexOf("## Shell commands"), ipython.indexOf("## Python environments"));
	const positions = PARALLEL_RULES.map((rule) => shell.indexOf(rule));
	expect(positions.every((index) => index > shell.indexOf("check `.exit_code` before reporting success"))).toBe(true);
	expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	if (notices) expect(shell.indexOf(NOTICE_RULE)).toBeGreaterThan(positions.at(-1)!);
	else expect(ipython).not.toContain("bash-done");
});

test.each([false, true])("disabling parallelWorkPrompt restores the old prompt with notices %s", async (notices) => {
	h = await createHarness({
		mode: "rpc",
		setup: (dirs) => writeConfigs(dirs, { parallelWorkPrompt: false, backgroundNotices: notices }),
	});
	const ipython = section((await providerRequest(h)).prompt, "ipython");
	for (const rule of PARALLEL_RULES) expect(ipython).not.toContain(rule.trim());
	if (notices) expect(ipython).toContain(`\n  - A command that outlives its Cell sends a Background-command notice (\`[bash-done …]\`)`);
	else expect(ipython).not.toContain("bash-done");
});

test("the provider sees raw-string examples in the ipython code parameter", async () => {
	h = await createHarness();
	const { parameters } = await providerRequest(h);

	for (const example of [String.raw`re.search(r'\.', text)`, String.raw`await bash(r"rg 'LetterBox\(' .")`]) {
		expect(parameters).toHaveProperty("properties.code.description", expect.stringContaining(example));
	}
});

test("exclusive tool selection is reflected in the prompt even when another extension activates bash", async () => {
	h = await createHarness({
		extensions: [(pi) => {
			pi.on("session_start", () => { pi.setActiveTools(["bash"]); });
		}],
	});
	expect(h.session.getActiveToolNames()).toEqual(["bash"]);
	const { prompt } = await providerRequest(h);
	expect(section(prompt, "tools")).toContain("- ipython:");
	expect(section(prompt, "tools")).not.toContain("- bash:");
	expect(section(prompt, "rules")).not.toContain("Use bash");
});

const GUIDELINES = "<guidelines>\nBe kind.\n</guidelines>";

test.each(["before", "after"] as const)("an extension editing systemPrompt %s pi-ipython keeps its edit next to the ipython section", async (order) => {
	const guidelines = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => ({
			systemPrompt: event.systemPrompt.replace("<docs>\n", `${GUIDELINES}\n\n<docs>\n`),
		}));
	};
	h = await createHarness(order === "before" ? { extensionsBefore: [guidelines] } : { extensions: [guidelines] });
	const { prompt } = await providerRequest(h);

	expect(prompt).toContain("<guidelines>\nBe kind.\n</guidelines>");
	expect(prompt.split("<ipython>\n")).toHaveLength(2);
	expect(prompt.indexOf("<ipython>")).toBeGreaterThan(prompt.indexOf("<rules>"));
	expect(prompt.indexOf("<ipython>")).toBeLessThan(prompt.indexOf("<docs>"));
});

test.each(["before", "after"] as const)("systemPrompt.ipythonAfter stays ahead of a before-docs insert from an extension loaded %s pi-ipython", async (order) => {
	// Like a guidelines extension inserting before <docs>, followed by one that removes <docs>.
	const guidelines = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => ({
			systemPrompt: event.systemPrompt
				.replace("<docs>\n", `${GUIDELINES}\n\n<docs>\n`)
				.replace(/<docs>\n[\s\S]*?\n<\/docs>\n*/, ""),
		}));
	};
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { systemPrompt: { ipythonAfter: ["rules"] } }),
		...(order === "before" ? { extensionsBefore: [guidelines] } : { extensions: [guidelines] }),
	});
	const { prompt } = await providerRequest(h);

	expect(prompt.split("<ipython>\n")).toHaveLength(2);
	expect(prompt).toContain("</rules>\n\n<ipython>\n");
	expect(prompt).toContain("</ipython>\n\n<guidelines>\nBe kind.\n</guidelines>");
	expect(prompt).not.toContain("<docs>");
});

test("systemPrompt.ipythonAfter preserves blank lines after the anchor", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { systemPrompt: { ipythonAfter: ["rules"] } }),
		extensionsBefore: [(pi) => {
			pi.on("before_agent_start", (event) => ({
				systemPrompt: event.systemPrompt.replace("</rules>", `</rules>\n\n\n\n${GUIDELINES}`),
			}));
		}],
	});
	const { prompt } = await providerRequest(h);

	expect(prompt.split("<ipython>\n")).toHaveLength(2);
	expect(prompt).toContain("</rules>\n\n<ipython>\n");
	expect(prompt).toContain(`</ipython>\n\n\n\n${GUIDELINES}\n\n<docs>`);
});

test.each(["ipythonAfter", "ipythonBefore"] as const)("systemPrompt.%s can anchor to generated skills", async (key) => {
	h = await createHarness({
		setup: (dirs) => {
			writeConfigs(dirs, { systemPrompt: { [key]: ["skills"] } });
			const skillDir = join(dirs.agentDir, "skills", "csv-tricks");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "---\nname: csv-tricks\ndescription: Parse CSV files fast.\n---\nUse pandas.\n");
		},
	});
	const prompt = await systemPrompt(h);

	expect(prompt).toContain(key === "ipythonAfter" ? "</skills>\n\n<ipython>" : "</ipython>\n\n<skills>");
	expect(prompt.indexOf("<ipython>")).toBeLessThan(prompt.indexOf("<cwd>"));
});

test("systemPrompt.ipythonAfter falls back to ipythonBefore when none of its sections is present", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { systemPrompt: { ipythonAfter: ["nonexistent"], ipythonBefore: ["cwd"] } }),
	});
	const { prompt } = await providerRequest(h);

	expect(prompt).toContain("</ipython>\n\n<cwd>");
	expect(prompt.indexOf("<ipython>")).toBeGreaterThan(prompt.indexOf("<docs>"));
});

test("an invalid systemPrompt.ipythonAfter is reported and the default placement stays", async () => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => writeConfigs(dirs, { systemPrompt: { ipythonAfter: "rules" } }),
	});
	expect(notices).toEqual([expect.stringContaining('"systemPrompt.ipythonAfter" must be an array of section tag names')]);
	const { prompt } = await providerRequest(h);
	expect(prompt).toContain("</ipython>\n\n<docs>");
});

test.each(["ipythonAfter", "ipythonBefore"] as const)("an invalid project %s reports the file and resets placement", async (key) => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => writeConfigs(
			dirs,
			{ systemPrompt: { ipythonAfter: ["tools"], ipythonBefore: ["cwd"] } },
			{ systemPrompt: { [key]: ["<bad>"] } },
		),
	});
	expect(notices).toEqual([expect.stringContaining(
		`${join(h.cwd, ".pi", "pi-ipython.json")}: "systemPrompt.${key}" must be an array of section tag names`,
	)]);
	expect(await systemPrompt(h)).toContain("</ipython>\n\n<docs>");
});

test("SYSTEM.md replaces pi's opening, tools, rules, and docs; the ipython section and APPEND_SYSTEM.md stay", async () => {
	h = await createHarness({
		setup: ({ agentDir }) => {
			writeFileSync(join(agentDir, "SYSTEM.md"), "You are a careful data analyst.");
			writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Always cite your sources.");
		},
	});
	const { prompt } = await providerRequest(h);

	expect(prompt.startsWith("You are a careful data analyst.")).toBe(true);
	for (const name of ["tools", "rules", "docs"]) expect(prompt).not.toContain(`<${name}>`);
	expect(section(prompt, "addendum")).toBe("Always cite your sources.");
	// Before the first section pi renders after its docs.
	expect(prompt.indexOf("<ipython>\nYou have one tool")).toBeGreaterThan(0);
	expect(prompt.indexOf("<ipython>")).toBeLessThan(prompt.indexOf("<addendum>"));
	expect(prompt.indexOf("</ipython>")).toBeLessThan(prompt.indexOf("<cwd>"));
});

test("section examples in custom prompts stay intact and do not affect insertion", async () => {
	const custom = "~~~xml\r\n<ipython>\r\nExample only.\r\n</ipython>\r\n~~~";
	const append = "```xml\n<docs>\nExample docs.\n</docs>\n```";
	h = await createHarness({
		setup: ({ agentDir }) => {
			writeFileSync(join(agentDir, "SYSTEM.md"), custom);
			writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), append);
		},
	});
	const { prompt } = await providerRequest(h);
	const ipython = prompt.indexOf("<ipython>\nYou have one tool");
	expect(ipython).toBeGreaterThan(0);
	expect(ipython).toBeLessThan(prompt.indexOf("<addendum>"));
	expect(prompt.startsWith(custom)).toBe(true);
	expect(section(prompt, "addendum")).toBe(append);
});

test("complete sections in an earlier forced prompt are recognized without duplication", async () => {
	const ipython = "<ipython>Custom REPL instructions.</ipython>";
	const cwd = "<cwd>\r\n/custom\r\n</cwd>";
	h = await createHarness({
		setup: ({ agentDir }) => {
			const skillDir = join(agentDir, "skills", "csv-tricks");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "---\nname: csv-tricks\ndescription: Parse CSV files fast.\n---\nUse pandas.\n");
		},
		extensionsBefore: [(pi) => {
			pi.on("before_agent_start", () => ({ systemPrompt: `${ipython}\r\n\r\n${cwd}` }));
		}],
	});
	const { prompt } = await providerRequest(h);
	expect(prompt.match(/<ipython>/g)).toEqual(["<ipython>"]);
	expect(prompt).toContain(ipython);
	expect(prompt.indexOf("<skills>")).toBeGreaterThan(0);
	expect(prompt.indexOf("</skills>")).toBeLessThan(prompt.indexOf(cwd));
});

test.each(["direct", "codemode", "deferred"] as const)("the ipython description explains pi discovery for %s tools; the prompt never mentions pi", async (exposure) => {
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
	const { prompt, description } = await providerRequest(h);

	expect(prompt).not.toContain("pi.");
	expect(prompt).not.toContain("frobnicate");
	const section = piSection(description)!;
	expect(section).toContain("await pi.tool(");
	expect(section).toContain("await pi.tools()");
	expect(section.endsWith("Before first using a tool, call `await pi.describe(name)` to read its schema, guidelines, and returns.")).toBe(true);
	expect(section).toContain("await pi.describe_namespace(name)");
	expect(description.split("describe_namespace")).toHaveLength(2);
	expect(section).toContain("await pi.search(query: str, limit: int = 8, namespace: str | None = None)");
	expect(description.split("pi.search")).toHaveLength(2);
});

test("piTools.search false leaves pi.search out of the description and keeps the rest of the pi section", async () => {
	const frobnicate = (pi: ExtensionAPI) => pi.registerTool({
		name: "frobnicate",
		label: "frobnicate",
		description: "Frobnicate a widget.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	});
	h = await createHarness({ extensions: [frobnicate] });
	const on = (await providerRequest(h)).description;
	await h.dispose();
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ piTools: { search: false } }));
		},
		extensions: [frobnicate],
	});
	const off = (await providerRequest(h)).description;
	expect(off).not.toContain("search(");
	expect(off).toContain("await pi.tools()");
	const searchLine = on.split("\n").find((line) => line.includes("pi.search"))!;
	expect(on.replace(`${searchLine}\n`, "")).toBe(off);
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
	const { prompt, description } = await providerRequest(h);
	expect(prompt).not.toContain("await pi.");
	expect(description).not.toContain("await pi.");
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
	expect(piSection((await providerRequest(h)).description)).toBeUndefined();
	register("codemode");
	expect(piSection((await providerRequest(h)).description)).toContain("await pi.tools()");
	register("hidden");
	expect(piSection((await providerRequest(h)).description)).toBeUndefined();
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
	expect(piSection((await providerRequest(h)).description)).toContain("await pi.tools()");
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
	const requests: ProviderRequest[] = [];
	h.setResponses([
		(context) => {
			requests.push(seen(context));
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "await pi.tool('toggle')" }), { stopReason: "toolUse" });
		},
		(context) => {
			requests.push(seen(context));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("hide the tool");
	expect(requests).toHaveLength(2);
	expect(piSection(requests[0]!.description)).toContain("await pi.tools()");
	expect(piSection(requests[1]!.description)).toBeUndefined();
	// The prompt is fixed for the run.
	expect(requests[1]!.prompt).toBe(requests[0]!.prompt);
});
