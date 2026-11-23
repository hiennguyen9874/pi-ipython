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
import { MAX_MODEL_CALLS_IN_FLIGHT } from "../bridge/model-calls.ts";
import { DEFAULT_PACKAGE_PRELUDE, PRE_IMPORTED_PACKAGE_LABELS } from "../kernel/packages.ts";
import { DEFAULT_PRELUDE, preludeNames } from "../kernel/prelude.ts";
import { SECTION_TAG_NAME } from "./section-tag.ts";

const CORE_PROMPT = `You have one tool, \`ipython\`. Each call runs a Cell in a persistent CPython Kernel. Write plain Python with top-level \`await\` (IPython \`%magic\` and \`!cmd\` are unavailable). Read and edit files in Python; run programs, including \`rg\` for search, with \`bash()\`.

## Shell commands

- \`bash(command: str, timeout: float | None = 600) -> BashHandle\` starts a command in a new process and returns at once; after \`timeout\` seconds it is killed (\`None\`: no limit).
  - \`r = await bash(cmd)\` waits and gives a \`BashResult\` of plain values: \`.exit_code\`, \`.output\`, \`.duration\`.
  - \`h = bash(cmd)\` gives a live \`BashHandle\`: \`.running\`, \`.tail(n=50)\`, \`.output()\`, \`.poll() -> BashResult | None\`, \`.kill()\`, \`.pid\`, \`.command\`; \`await h\` gives its \`BashResult\`.
- Write logic, loops, and parsing in Python; chain dependent shell steps with \`&&\`. \`os.chdir()\` and \`os.environ\` changes carry over to later \`bash()\` calls.
- A build, test, or install passed only if its \`.exit_code\` is 0: check it before reporting success.`;

/** With parallelWorkPrompt on. */
const PARALLEL_WORK_RULES = [
	"- Fan out commands that touch separate files, state, and ports, then collect them: `hs = [bash(c) for c in cmds]; rs = [await h for h in hs]`.",
	"- Wait for a long command with `await h`. While independent work remains, keep `h`, do that work, and `await h` in a later Cell.",
];

/** With Background-command notices on; the notice itself says how to read the result. */
const BACKGROUND_NOTICE_RULE = "- If nothing else can proceed until a long command finishes, end the turn rather than await it: keep its handle and say what is pending. A `[bash-done …]` notice starts a later turn for it, possibly batched with other commands or delayed.";

const PI_TOOLS_HEAD = [
	"- `pi`: the session's other tools (extension tools such as subagents or MCP servers), callable from Python; all of it is async",
	"  - `await pi.tools()`: list the callable tools as dicts with `name`, `description` (first line), and `namespace`",
];

const PI_SEARCH_LINE = "  - `await pi.search(query: str, limit: int = 8, namespace: str | None = None)`: the callable tools that best match `query` (words or a tool name), best first, as entries like `pi.tools()`; `namespace` searches only that namespace's tools";

const PI_TOOLS_CALLS = [
	"  - `await pi.describe(name)`: a tool's full `description`, `parameters` JSON schema, usage `guidelines`, and `returns` (output schema, or `\"str\"`)",
	"  - `await pi.describe_namespace(name)`: a namespace's (for example an MCP server's) `description` and `instructions`",
	"  - `await pi.tool(name, args: dict | None = None)`: call a tool; returns a dict for tools with an output schema, otherwise text, and raises `pi.ToolError` on failure",
];

/** With parallelWorkPrompt on. */
const PI_CONCURRENCY_LINE = "  - Fan out calls that touch separate files and state: `import asyncio; await asyncio.gather(pi.tool(a, x), pi.tool(b, y))`.";

const PI_DESCRIBE_FIRST_LINE = "  - Before first using a tool, call `await pi.describe(name)` to read its schema, guidelines, and returns.";

const ENVIRONMENT_LINE = "- Run each project in its own environment (`uv run`, `.venv/bin/python`, or its documented commands); Kernel packages serve Cells only.";

const CELL_PROMPT = `## Working in Cells

- Batch steps whose intermediate results you do not need to see. Print just enough: slices, counts, a handle's \`.tail()\`.
- Edit by replacing a unique match: confirm the old text occurs exactly once first.
- Keep data in named variables; Python state survives across Cells and compaction, until Kernel replacement.`;

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

/** Whether the prompt lists the default packages' pre-imports. */
function listsPackageImports(prelude: PromptPrelude | undefined): boolean {
	return !!prelude && prelude.defaults && prelude.includeDefaultPackageImports;
}

/**
 * What the prelude bound, scoped to Cells so written files keep their imports. Stdlib defaults
 * are named; configured imports are shown whole, so the model uses them.
 */
function preludeLines(prelude: PromptPrelude): string[] {
	const { defaults, imports } = prelude;
	const withPackages = listsPackageImports(prelude);
	const configured = [...new Set(imports.map((statement) => statement.trim()))]
		.filter((statement) => !(defaults && DEFAULT_PRELUDE.includes(statement)))
		.filter((statement) => !(withPackages && DEFAULT_PACKAGE_PRELUDE.includes(statement)));
	if (!defaults && configured.length === 0) return [];
	return [
		"- Pre-imported in Cells only; files and scripts you write need their own imports:",
		...(defaults ? [`  - stdlib: ${DEFAULT_PRELUDE_TEXT}`] : []),
		...(withPackages ? [`  - packages: ${preludeNames(DEFAULT_PACKAGE_PRELUDE).join(", ")}`] : []),
		...(configured.length > 0
			? [`  - configured for this project, use them where they fit: ${configured.map((s) => `\`${s}\``).join("; ")}`]
			: []),
	];
}

const INSTALL_COMMAND = '`import shlex, sys; r = await bash(f"uv pip install --python {shlex.quote(sys.executable)} package-name")`';

/** The Kernel packages not already listed as pre-imports, and how to add one. */
function packagesLine(labels: readonly string[], listedImports: boolean): string {
	const others = listedImports ? labels.filter((label) => !PRE_IMPORTED_PACKAGE_LABELS.includes(label)) : labels;
	const install = `${INSTALL_COMMAND}, then check \`r.exit_code\`.`;
	if (others.length === 0) return `- Add a Kernel package with ${install}`;
	const heading = others.length < labels.length ? "Other Kernel packages" : "Installed Kernel packages";
	return `- ${heading}: ${others.join(", ")}. Add one with ${install}`;
}

export interface IpythonPromptOptions {
	/** Without it, the prompt does not mention the prelude. */
	prelude?: PromptPrelude;
	/** Adds the rule for commands that outlive their Cell. */
	backgroundNotices?: boolean;
	/** Adds parallel-work and waiting guidance. */
	parallelWorkPrompt?: boolean;
	/** The Kernel packages (uv mode only; without it the prompt does not say how to install one). */
	packageLabels?: readonly string[];
}

/** The `<ipython>` section: the REPL's functions and rules, joined line by line. */
export function ipythonSection({ prelude, backgroundNotices = false, parallelWorkPrompt = true, packageLabels }: IpythonPromptOptions): string {
	const shell = [
		CORE_PROMPT,
		...(parallelWorkPrompt ? PARALLEL_WORK_RULES : []),
		...(backgroundNotices ? [BACKGROUND_NOTICE_RULE] : []),
	];
	const environment = [
		"## Python environments",
		"",
		ENVIRONMENT_LINE,
		...(prelude ? preludeLines(prelude) : []),
		...(packageLabels ? [packagesLine(packageLabels, listsPackageImports(prelude))] : []),
	];
	return [shell.join("\n"), environment.join("\n"), CELL_PROMPT].join("\n\n");
}

/**
 * The `pi` API, for the `ipython` description while a Pi tool is callable: it can change within a run,
 * which the forced prompt cannot. `search` is whether `pi.search` is on.
 */
export function piToolsSection(search: boolean, parallelWorkPrompt = true): string {
	return [
		...PI_TOOLS_HEAD,
		...(search ? [PI_SEARCH_LINE] : []),
		...PI_TOOLS_CALLS,
		...(parallelWorkPrompt ? [PI_CONCURRENCY_LINE] : []),
		PI_DESCRIBE_FIRST_LINE,
	].join("\n");
}

const PI_ASK_SIGNATURE_START = "- `await pi.ask(prompt: str, *, system: str | None = None";
const PI_ASK_SIGNATURE_END = ") -> str`: send `prompt` to a model without tools or history and return its answer text";
const PI_ASK_USE_LINE = "  - Use it for semantic work code cannot do reliably, such as summarizing or extracting from text. Check the answer against the task before using it.";
const PI_ASK_IMAGES_LINE = "  - Pass `images` to read or describe many images without adding them to the context; they are sent before `prompt`.";

const PI_ASK_FALLBACK_LINE = "  - For yes/no, labels, or scores, request a structured answer and validate it before using it.";
const PI_ASK_BATCH_LINE = "  - For independent prompts, take `batch = prompts[:remaining]` (`remaining` is the unused Cell budget), then `rs = await asyncio.gather(*(pi.ask(p) for p in batch), return_exceptions=True)`. Pair results with inputs; keep answers and handle exceptions separately.";

/** The shared images line; `apis` names the APIs it applies to when more than one takes images. */
const imagesLine = (apis = "") =>
	`  - \`images\`${apis} takes a list of paths, bytes, or PIL.Image; PNG/JPEG/WebP/GIF. Relative paths use the Kernel's current directory.`;

const PI_CLASSIFY_LINES = [
	"  - Prefer typed answers to parsing free text for yes/no, label selection, or scoring. Ask all questions about one `state` in one call.",
	'  - Pass a non-empty `questions` dict mapping string IDs to question objects. For example: `a = await pi.classify({"review": text}, {"positive": {"type": "bool", "instructions": "Is the review positive?", "criteria": {"true": "Positive", "false": "Not positive"}}})`; read `a["positive"]["probability"]`.',
	'  - Each question has `type`, `instructions` (a string), and `criteria`: for `bool`, `{"true": meaning, "false": meaning}`; for `choice`, `{label: meaning}`; for `score`, `[level, ...]` (lowest first). Meanings and levels are strings.',
	'  - Answers include `type` and: for bool, `probability` of true; for choice, the label in `choice`, per-label `probabilities`, and `confidence`; for score, `score` (expected level index) and `confidence`.',
];

/** Model-call limits and guidance for the APIs that resolve in the live `ipython` loadout. */
export function modelCallsSection({ maxPerCell, ask, classify, askImages = false, classifierImages = false }: {
	maxPerCell: number;
	ask: boolean;
	classify: boolean;
	askImages?: boolean;
	classifierImages?: boolean;
}): string | undefined {
	const calls = [ask && "`pi.ask`", classify && "`pi.classify`"].filter(Boolean).join(" and ");
	if (!calls) return undefined;
	return [
		`- Model calls (${calls}): at most ${maxPerCell} total per Cell, with at most ${MAX_MODEL_CALLS_IN_FLIGHT} in flight. The host queues calls waiting for a slot. Fit each batch within the remaining Cell budget and process the rest in later Cells.`,
		"  - Await Model calls in their originating Cell. Failed requests raise `pi.ModelCallError`.",
		...(ask ? [
			`${PI_ASK_SIGNATURE_START}${askImages ? ", images: list | None = None" : ""}${PI_ASK_SIGNATURE_END}`,
			PI_ASK_USE_LINE,
			// The images line appears once, under the first API that takes images.
			...(askImages ? [PI_ASK_IMAGES_LINE, imagesLine(classifierImages ? " (for `pi.ask` and `pi.classify`)" : "")] : []),
			...(!classify ? [PI_ASK_FALLBACK_LINE] : []),
			PI_ASK_BATCH_LINE,
		] : []),
		...(classify ? [
			`- \`await pi.classify(state: dict, questions: dict${classifierImages ? ", *, images=None" : ""}) -> dict\`: ask a classifier model typed questions about the JSON \`state\`; returns the answers by question ID`,
			...(classifierImages && !askImages ? [imagesLine()] : []),
			...PI_CLASSIFY_LINES,
		] : []),
	].join("\n");
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
