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
import { SECTION_TAG_NAME } from "./section-tag.ts";

const CORE_PROMPT = `You have one tool, \`ipython\`. Each call runs a Cell in a persistent CPython Kernel. Use plain Python with top-level \`await\`; IPython \`%magic\` and \`!cmd\` syntax are unavailable. Inside a Cell, use Python to read, search, and edit files. Use \`bash()\` to run external programs.

## Shell commands

- \`bash(command: str, timeout: float | None = 600) -> BashHandle\`: start a shell command in a new process and return at once. Commands still running after \`timeout\` seconds are killed (\`None\`: no limit).
  - \`r = await bash(cmd)\` waits and gives a \`BashResult\`: \`.exit_code\`, \`.output\`, \`.duration\` (plain values; no \`.tail()\`, not awaitable).
  - \`h = bash(cmd)\` gives a \`BashHandle\`: \`.pid\`, \`.running\`, \`.command\`, \`.tail(n=50)\`, \`.output()\`, \`.poll() -> BashResult | None\`, \`.kill(sig=SIGTERM, grace=5.0)\`; \`await h\` gives its \`BashResult\`.
  - Write logic, loops, and parsing in Python. Use \`&&\` for dependent shell steps and raw Python strings for commands with literal backslashes.
  - \`os.chdir()\` and \`os.environ\` changes persist and apply to later \`bash()\` calls.
  - For builds, tests, and other required commands, get the \`BashResult\` and check \`.exit_code\` before reporting success. A successful Cell only confirms that the Python code ran.`;

const PI_TOOLS_HEAD = `- \`pi\`: the session's other tools (extension tools such as subagents or MCP servers), callable from Python; all of it is async
  - \`await pi.tools()\`: list the callable tools as dicts with \`name\`, \`description\` (first line), and \`namespace\``;

const PI_SEARCH_PROMPT = `  - \`await pi.search(query: str, limit: int = 8, namespace: str | None = None)\`: the callable tools that best match \`query\` (words or a tool name), best first, as entries like \`pi.tools()\`; \`namespace\` searches only that namespace's tools`;

const PI_TOOLS_TAIL = `  - \`await pi.describe(name)\`: a tool's full \`description\`, \`parameters\` JSON schema, usage \`guidelines\`, and \`returns\` (output schema, or \`"str"\`)
  - \`await pi.describe_namespace(name)\`: a namespace's (for example an MCP server's) \`description\` and \`instructions\`
  - \`await pi.tool(name, args: dict | None = None)\`: call a tool; returns a dict for tools with an output schema, otherwise text, and raises \`pi.ToolError\` on failure
  - Before first using a tool, call \`await pi.describe(name)\` to read its schema, guidelines, and returns.`;

/** Only with Background-command notices on. */
const BACKGROUND_NOTICE_RULE = `  - A command that outlives its Cell sends a Background-command notice (\`[bash-done …]\`) on completion. If no other work can proceed until a long command finishes, keep its handle and end the turn with the command pending. When the notice arrives, get its \`BashResult\` from the handle.`;

const ENVIRONMENT_PROMPT = `## Python environments

- Run external projects in their own environment (\`uv run\`, \`.venv/bin/python\`, or the project's documented commands). Install packages in the Kernel only for use in Cells.`;

const CELL_PROMPT = `## Working in Cells

- Batch steps in one Cell when you do not need to inspect an intermediate result.
- For targeted text edits, verify that the old text occurs exactly once before replacing it. Otherwise, inspect the file and refine the match.
- Use raw strings for regexes, e.g. \`r'\\.'\`. Double literal braces (\`{{ }}\`) in f-strings.
- Reuse named variables for data you read or compute. Python state (variables, functions, and imports) survives between Cells and through compaction, but not Kernel replacement.
- State assumptions that affect the result.`;

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
	const shell = [CORE_PROMPT, ...(backgroundNotices ? [BACKGROUND_NOTICE_RULE] : [])].join("\n");
	const environment = [
		ENVIRONMENT_PROMPT,
		...(preludeLine ? [preludeLine] : []),
		...(packageLabels ? [packagesPrompt(packageLabels)] : []),
	].join("\n");
	return [shell, environment, CELL_PROMPT].join("\n\n");
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

/** Start and end offsets of complete sections, ignoring Markdown examples without changing offsets. */
function sectionRanges(prompt: string): Map<string, { start: number; end: number }> {
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
	const ranges = new Map<string, { start: number; end: number }>();
	const completeSection = new RegExp(String.raw`^<(${SECTION_TAG_NAME})>(?:[^\r\n]*|\r?\n[\s\S]*?^)</\1>[ \t]*(?=\r?$)`, "gm");
	for (const match of unfenced.matchAll(completeSection)) {
		const name = match[1]!;
		if (!ranges.has(name)) ranges.set(name, { start: match.index, end: match.index + match[0].length });
	}
	return ranges;
}

/** Where to insert a section: right after the first of `after` present, else before the first of `before`. */
interface SectionPlacement {
	after?: readonly string[];
	before: readonly string[];
}

function insertSection(prompt: string, name: string, content: string, { after = [], before }: SectionPlacement): string {
	const ranges = sectionRanges(prompt);
	if (ranges.has(name)) return prompt;
	const section = `<${name}>\n${content}\n</${name}>`;
	for (const marker of after) {
		const range = ranges.get(marker);
		if (!range) continue;
		const tail = prompt.slice(range.end);
		// Reuse existing line breaks instead of collapsing spacing from another extension.
		const separator = !tail || /^\r?\n[ \t]*\r?\n/.test(tail) ? "" : "\n";
		return `${prompt.slice(0, range.end)}\n\n${section}${separator}${tail}`;
	}
	for (const marker of before) {
		const range = ranges.get(marker);
		if (range) return `${prompt.slice(0, range.start)}${section}\n\n${prompt.slice(range.start)}`;
	}
	return prompt.trim() ? `${prompt.trimEnd()}\n\n${section}` : section;
}

/** Add the skills list before `<cwd>`, then place `<ipython>` using the complete set of sections. */
export function extendSystemPrompt(
	systemPrompt: string,
	skills: readonly Skill[],
	options: IpythonPromptOptions,
	placement: SectionPlacement,
): string {
	const skillsContent = skillsSection(skills);
	const prompt = skillsContent ? insertSection(systemPrompt, "skills", skillsContent, { before: ["cwd"] }) : systemPrompt;
	return insertSection(prompt, "ipython", ipythonSection(options), placement);
}
