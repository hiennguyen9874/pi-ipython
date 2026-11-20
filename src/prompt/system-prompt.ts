// The sections pi-ipython inserts into pi's system prompt (ADR 0005): an Unharnessed-style
// REPL section and the skills list, which pi leaves out without an active file-reading tool.
//
// Adapted from Unharnessed (crates/uh-core/src/prompts/layers/core.md and
// system_prompt.rs at HEAD; packages/coding-agent/src/core/prompts/rlm.ts at 7d442aafa),
// without the spawn, factory, and memory sections; the Background-command notice rule only when enabled.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// MIT License, see LICENSE.

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PACKAGE_PRELUDE } from "../kernel/packages.ts";
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

/** Only with Background-command notices on. */
const BACKGROUND_NOTICE_RULE = `- A \`bash()\` command still running when its Cell ends sends you a \`[bash-done …]\` message when it finishes, even after your turn has ended. For long commands, start \`h = bash(...)\` and end your turn; don't \`sleep\` or \`await\` just to hold the turn open.`;

const RULES_HEAD = `## Rules

- The REPL runs plain Python, not IPython: \`%magic\` commands and \`!cmd\` shell escapes are not supported. Use \`bash()\` to run programs.
- Keep in mind that each tool call is a round trip: steps that do not need a result you have not seen yet can go in one call.
- Run programs with \`bash()\`, not \`subprocess\` or \`os.system\`. Write logic, loops and parsing in Python; use \`bash()\` only to call programs.
- A \`bash()\` command is a Python string: use \`r'...'\` when it contains backslashes, and double literal braces (\`{{ }}\`) in f-strings.
- Read, search, and edit files with Python.
- \`os.chdir()\` and \`os.environ\` changes persist and apply to later \`bash()\` calls.`;

const RULES_TAIL = `- Store what you read or compute in named variables instead of reading it again.
- Python variables survive compaction, but not a Kernel restart.
- Run an external project through its own environment (\`uv run\`, \`.venv/bin/python\`, its documented commands); install into the kernel only packages you need in the REPL itself.
- When you are done, stop calling tools and give the final answer, with any assumption you made.`;

export interface PromptPrelude {
	/** Whether the default stdlib prelude runs. */
	defaults: boolean;
	/** Whether the default packages' imports run (the default packages are installed). */
	includeDefaultPackageImports: boolean;
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
function preludePrompt({ defaults, includeDefaultPackageImports, imports }: PromptPrelude): string | undefined {
	const withPackages = defaults && includeDefaultPackageImports;
	const configured = [...new Set(imports.map((statement) => statement.trim()))]
		.filter((statement) => !(defaults && DEFAULT_PRELUDE.includes(statement)))
		.filter((statement) => !(withPackages && DEFAULT_PACKAGE_PRELUDE.includes(statement)));
	if (!defaults && configured.length === 0) return undefined;
	return [
		"- Pre-imported in the REPL only (files and scripts you write still need their own imports):",
		...(defaults ? [`  - stdlib: ${DEFAULT_PRELUDE_TEXT}`] : []),
		...(withPackages ? [`  - packages: ${preludeNames(DEFAULT_PACKAGE_PRELUDE).join(", ")}`] : []),
		...(configured.length > 0
			? [`  - installed and configured for this project, use them where they fit: ${configured.map((s) => `\`${s}\``).join("; ")}`]
			: []),
	].join("\n");
}

const INSTALL_COMMAND = '`import shlex, sys; await bash(f"uv pip install --python {shlex.quote(sys.executable)} package-name")`';

/** The Kernel packages and how to add one; packages the model installs are not recorded anywhere. */
function packagesPrompt(labels: readonly string[]): string {
	if (labels.length === 0) return `- Install Python packages with ${INSTALL_COMMAND}; they last until the Kernel environment is rebuilt.`;
	return `- Installed Kernel packages: ${labels.join(", ")}. Install more with ${INSTALL_COMMAND}; packages you install last until the Kernel environment is rebuilt.`;
}

export interface IpythonPromptOptions {
	/** Without it, the prompt does not mention the prelude. */
	prelude?: PromptPrelude;
	/** Adds the rule for commands that outlive their Cell. */
	backgroundNotices?: boolean;
	/** The Kernel packages (uv mode only; without it the prompt does not say how to install one). */
	packageLabels?: readonly string[];
}

/** The `<ipython>` section: the REPL's functions and rules. */
export function ipythonSection({ prelude, backgroundNotices = false, packageLabels }: IpythonPromptOptions): string {
	const preludeLine = prelude && preludePrompt(prelude);
	const functions = [
		CORE_PROMPT,
		...(preludeLine ? [preludeLine] : []),
		...(packageLabels ? [packagesPrompt(packageLabels)] : []),
	].join("\n");
	const rules = [RULES_HEAD, ...(backgroundNotices ? [BACKGROUND_NOTICE_RULE] : []), RULES_TAIL].join("\n");
	return `${functions}\n\n${rules}`;
}

/**
 * The `pi` API, for the `ipython` description while a Pi tool is callable: it can change within a run,
 * which the forced prompt cannot. `search` is whether `pi.search` is on.
 */
export function piToolsSection(search: boolean): string {
	return [PI_TOOLS_HEAD, ...(search ? [PI_SEARCH_PROMPT] : []), PI_TOOLS_TAIL].join("\n");
}

/** The `<skills>` section's content, or undefined when no skill is visible to the model. */
function skillsSection(skills: readonly Skill[]): string | undefined {
	const listed = formatSkillsForPrompt([...skills], "indirect").trim();
	if (!listed) return undefined;
	return `Read a skill's SKILL.md with Python at its listed location, e.g. \`open(location).read()\`.\n${listed}`;
}

/** Start offsets of complete sections, ignoring Markdown examples without changing offsets. */
function sectionStarts(prompt: string): Map<string, number> {
	let fence: string | undefined;
	const unfenced = prompt.replace(/[^\r\n]+/g, (line) => {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
			return " ".repeat(line.length);
		}
		if (!marker) return line;
		fence = marker[1];
		return " ".repeat(line.length);
	});
	const starts = new Map<string, number>();
	for (const match of unfenced.matchAll(/^<([a-z][a-z0-9_-]*)>(?:[^\r\n]*|\r?\n[\s\S]*?^)<\/\1>[ \t]*(?=\r?$)/gm)) {
		const name = match[1]!;
		if (!starts.has(name)) starts.set(name, match.index);
	}
	return starts;
}

/** Insert `<name>` before the first of `before` present, else at the end; leave a prompt that has it alone. */
function insertSection(prompt: string, name: string, content: string, before: readonly string[]): string {
	const starts = sectionStarts(prompt);
	if (starts.has(name)) return prompt;
	const section = `<${name}>\n${content}\n</${name}>`;
	for (const marker of before) {
		const at = starts.get(marker);
		if (at !== undefined) return `${prompt.slice(0, at)}${section}\n\n${prompt.slice(at)}`;
	}
	return prompt.trim() ? `${prompt.trimEnd()}\n\n${section}` : section;
}

/**
 * Add the `<ipython>` section before pi's `<docs>` (or the next section pi renders after it) and the
 * skills list before `<cwd>`, keeping everything pi and other extensions put in `systemPrompt`.
 */
export function extendSystemPrompt(systemPrompt: string, skills: readonly Skill[], options: IpythonPromptOptions): string {
	let prompt = insertSection(systemPrompt, "ipython", ipythonSection(options), ["docs", "addendum", "project_context", "skills", "cwd"]);
	const skillsContent = skillsSection(skills);
	if (skillsContent) prompt = insertSection(prompt, "skills", skillsContent, ["cwd"]);
	return prompt;
}
