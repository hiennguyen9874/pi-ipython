// The forced system prompt: an Unharnessed-style REPL prompt plus pi's context files,
// skills, cwd, and date.
//
// Adapted from Unharnessed (crates/uh-core/src/prompts/layers/core.md and
// system_prompt.rs at HEAD; packages/coding-agent/src/core/prompts/rlm.ts at 7d442aafa),
// without the spawn, factory, memory, and bash wake-up sections.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// MIT License, see LICENSE.

import { type BuildSystemPromptOptions, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRELUDE, preludeNames } from "../kernel/prelude.ts";

const CORE_PROMPT = `You have one tool, \`ipython\`: a persistent CPython REPL where top-level \`await\` works. Every other capability is a Python function in that REPL. Variables, functions, and imports persist between calls.

## Functions in the REPL

- \`bash(command: str, timeout: float | None = 600) -> BashHandle\`: start a shell command in the background and return at once; each call is a new process, and a command still running after \`timeout\` seconds is killed (\`None\`: no limit)
  - \`r = await bash(cmd)\` waits and gives a \`BashResult\`: \`.exit_code\`, \`.output\`, \`.duration\` (plain values; no \`.tail()\`, not awaitable)
  - \`h = bash(cmd)\` gives a running \`BashHandle\`: \`.pid\`, \`.running\`, \`.command\`, \`.tail(n=50)\`, \`.output()\`, \`.poll() -> BashResult | None\`, \`.kill(sig=SIGTERM, grace=5.0)\`; \`await h\` gives its \`BashResult\``;

const PI_TOOLS_HEAD = `- \`pi\`: the session's other tools (extension tools such as subagents or MCP servers), callable from Python; all of it is async
  - \`await pi.tools()\`: list the callable tools as dicts with \`name\`, \`description\` (first line), and \`namespace\``;

const PI_SEARCH_PROMPT = `  - \`await pi.search(query: str, limit: int = 8, namespace: str | None = None)\`: the callable tools that best match \`query\` (words or a tool name), best first, as entries like \`pi.tools()\`; \`namespace\` searches only that namespace's tools`;

const PI_TOOLS_TAIL = `  - \`await pi.describe(name)\`: a tool's full \`description\`, \`parameters\` JSON schema, usage \`guidelines\`, and \`returns\` (output schema, or \`"str"\`)
  - \`await pi.describe_namespace(name)\`: a namespace's (for example an MCP server's) \`description\` and \`instructions\`
  - \`await pi.tool(name, args: dict | None = None)\`: call a tool; returns a dict for tools with an output schema, otherwise text, and raises \`pi.ToolError\` on failure
  - Before first using a tool, call \`await pi.describe(name)\` to read its schema, guidelines, and returns.`;

const RULES_PROMPT = `## Rules

- The REPL runs plain Python, not IPython: \`%magic\` commands and \`!cmd\` shell escapes are not supported. Use \`bash()\` to run programs.
- Keep in mind that each tool call is a round trip: steps that do not need a result you have not seen yet can go in one call.
- Run programs with \`bash()\`, not \`subprocess\` or \`os.system\`. Write logic, loops and parsing in Python; use \`bash()\` only to call programs.
- A \`bash()\` command is a Python string: use \`r'...'\` when it contains backslashes, and double literal braces (\`{{ }}\`) in f-strings.
- Read, search, and edit files with Python.
- \`os.chdir()\` and \`os.environ\` changes persist and apply to later \`bash()\` calls.
- Store what you read or compute in named variables instead of reading it again.
- Python variables survive compaction, but not a Kernel restart.
- Run an external project through its own environment (\`uv run\`, \`.venv/bin/python\`, its documented commands); do not install its dependencies into the kernel.
- When you are done, stop calling tools and give the final answer, with any assumption you made.`;

/** Local date as YYYY-MM-DD. */
function today(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface PromptPrelude {
	/** Whether the default stdlib prelude runs. */
	defaults: boolean;
	/** Configured import statements. */
	imports: readonly string[];
}

/** `datetime` is bound to the class; say so, since the module has the same name. */
const DEFAULT_PRELUDE_TEXT = preludeNames(DEFAULT_PRELUDE)
	.map((name) => (name === "datetime" ? "datetime (the class)" : name))
	.join(", ");

/**
 * What the prelude bound, scoped to the REPL so written files keep their imports. Stdlib defaults
 * are named; configured imports are shown whole and flagged as installed, so the model uses them.
 */
function preludePrompt({ defaults, imports }: PromptPrelude): string | undefined {
	const configured = [...new Set(imports.map((statement) => statement.trim()))]
		.filter((statement) => !(defaults && DEFAULT_PRELUDE.includes(statement)));
	if (!defaults && configured.length === 0) return undefined;
	return [
		"- Pre-imported in the REPL only (files and scripts you write still need their own imports):",
		...(defaults ? [`  - stdlib: ${DEFAULT_PRELUDE_TEXT}`] : []),
		...(configured.length > 0
			? [`  - installed and configured for this project, use them where they fit: ${configured.map((s) => `\`${s}\``).join("; ")}`]
			: []),
	].join("\n");
}

/** `piTools` is set when a Pi tool is callable; `search` is whether `pi.search` is on. Without `prelude`, the prompt does not mention it. */
export function buildSystemPrompt(
	options: Pick<BuildSystemPromptOptions, "cwd" | "contextFiles" | "skills">,
	piTools: { search: boolean } | undefined,
	prelude?: PromptPrelude,
): string {
	const preludeLine = prelude && preludePrompt(prelude);
	const functions = [
		CORE_PROMPT,
		...(preludeLine ? [preludeLine] : []),
		...(piTools ? [PI_TOOLS_HEAD, ...(piTools.search ? [PI_SEARCH_PROMPT] : []), PI_TOOLS_TAIL] : []),
	].join("\n");
	const parts = [functions, RULES_PROMPT];

	const contextFiles = options.contextFiles ?? [];
	if (contextFiles.length > 0) {
		parts.push(
			[
				"# Project Context",
				"",
				"Project-specific instructions and guidelines:",
				...contextFiles.map(({ path, content }) => `\n## ${path}\n\n${content}`),
			].join("\n"),
		);
	}

	const skills = formatSkillsForPrompt(options.skills ?? [], "indirect").trim();
	if (skills) parts.push(`# Skills\n\nRead a skill's SKILL.md with Python at its listed location, e.g. \`open(location).read()\`.\n${skills}`);

	parts.push(`Current date: ${today()}\nWorking directory: ${options.cwd.replace(/\\/g, "/")}`);
	return parts.join("\n\n");
}
