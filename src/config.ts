// Config: `<agentDir>/pi-ipython.json` (global) merged with `<cwd>/.pi/pi-ipython.json` (project).
// Project values win per key. An invalid file or value is reported and skipped, so defaults still apply.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PYTHON_VERSION } from "./kernel/bootstrap.ts";
import { DEFAULT_PACKAGE_PRELUDE, DEFAULT_PACKAGE_REQUIREMENTS, redactPackageUrls } from "./kernel/packages.ts";
import { DEFAULT_PRELUDE, preludeStatementNames } from "./kernel/prelude.ts";

export const CONFIG_FILE_NAME = "pi-ipython.json";

export interface PiIpythonConfig {
	confirmEachCell: boolean;
	/** Background-command notices: a finished Background command can start a turn (TUI and RPC only). */
	backgroundNotices: boolean;
	/** `packages` concatenates global then project entries; Kernel packages apply only with `source: "uv"`. */
	python: { source: "uv" | "project"; version: string; defaultPackages: boolean; packages: string[] };
	output: { maxBytes: number; maxLines: number };
	piTools: { list: boolean; search: boolean };
	/** `imports` concatenates global then project entries instead of the project winning. */
	prelude: { defaults: boolean; imports: string[]; prompt: boolean };
	/**
	 * Where `<ipython>` goes in pi's prompt: right after the first `ipythonAfter` section present,
	 * else before the first `ipythonBefore` section present, else at the end.
	 */
	systemPrompt: { ipythonAfter: string[]; ipythonBefore: string[] };
}

/** pi's sections that follow its `<rules>`, in render order: the default `systemPrompt.ipythonBefore`. */
export const DEFAULT_IPYTHON_BEFORE: readonly string[] = ["docs", "addendum", "project_context", "skills", "cwd"];

/**
 * The import statements the Kernel bootstrap runs: the defaults (unless turned off), plus the default packages'
 * imports when those packages are installed, then the configured imports.
 */
export function effectivePrelude(config: PiIpythonConfig): string[] {
	const defaults = config.prelude.defaults
		? [...DEFAULT_PRELUDE, ...(hasDefaultPackages(config) ? DEFAULT_PACKAGE_PRELUDE : [])]
		: [];
	return [...new Set([...defaults, ...config.prelude.imports])];
}

/** The Kernel packages to install: the defaults (unless turned off), then the configured ones; none outside uv mode. */
export function effectivePackages(config: PiIpythonConfig): string[] {
	if (config.python.source !== "uv") return [];
	return [...new Set([...(config.python.defaultPackages ? DEFAULT_PACKAGE_REQUIREMENTS : []), ...config.python.packages])];
}

/** Whether the default packages' prelude applies: they are installed. */
export function hasDefaultPackages(config: PiIpythonConfig): boolean {
	return config.python.source === "uv" && config.python.defaultPackages;
}

export interface LoadedConfig {
	config: PiIpythonConfig;
	/** One message per problem, naming the file and the key. */
	errors: string[];
	warnings: string[];
}

const isPositiveInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const isSectionNames = (v: unknown) =>
	Array.isArray(v) && v.every((name) => typeof name === "string" && /^[a-z][a-z0-9_-]*$/.test(name));
const SECTION_NAMES_EXPECTED = 'an array of section tag names like "rules" (lowercase letters, digits, "_" or "-")';

/** Every supported key (dotted path), with its validator and a description of valid values. */
const FIELDS: Record<string, { valid: (v: unknown) => boolean; expected: string }> = {
	confirmEachCell: { valid: (v) => typeof v === "boolean", expected: "true or false" },
	backgroundNotices: { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"python.source": { valid: (v) => v === "uv" || v === "project", expected: '"uv" or "project"' },
	"python.version": {
		valid: (v) => {
			if (typeof v !== "string" || !/^\d+\.\d+(\.\d+)?$/.test(v)) return false;
			const [major, minor] = v.split(".").map(Number);
			return major! > 3 || (major === 3 && minor! >= 11);
		},
		expected: 'a Python version >=3.11 like "3.13"',
	},
	"python.defaultPackages": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"python.packages": { valid: Array.isArray, expected: "an array of uv requirement strings" },
	"output.maxBytes": { valid: isPositiveInt, expected: "a positive integer" },
	"output.maxLines": { valid: isPositiveInt, expected: "a positive integer" },
	"piTools.list": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"piTools.search": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"prelude.defaults": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"prelude.imports": { valid: Array.isArray, expected: "an array of import statements" },
	"prelude.prompt": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"systemPrompt.ipythonAfter": { valid: isSectionNames, expected: SECTION_NAMES_EXPECTED },
	"systemPrompt.ipythonBefore": { valid: isSectionNames, expected: SECTION_NAMES_EXPECTED },
};
const SECTIONS = new Set(["python", "output", "piTools", "prelude", "systemPrompt"]);
const IMPORT_EXPECTED = 'one "import …" or "from … import …" statement (absolute, without "*")';
const PACKAGE_EXPECTED = 'a uv requirement string, not empty and not starting with "-"';

export function configPaths(cwd: string, agentDir = getAgentDir()): { global: string; project: string } {
	return {
		global: path.join(agentDir, CONFIG_FILE_NAME),
		project: path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
	};
}

export function loadConfig(cwd: string, agentDir = getAgentDir(), projectTrusted = false): LoadedConfig {
	const errors: string[] = [];
	const warnings: string[] = [];
	const values = new Map<string, unknown>();
	const paths = configPaths(cwd, agentDir);
	const global = readJsonObject(paths.global, errors);
	if (global) collect(global, paths.global, values, errors, true);
	const project = readJsonObject(paths.project, errors);
	if (project) collect(project, paths.project, values, errors, projectTrusted);
	const hasPackages = (raw: Record<string, unknown> | undefined) =>
		isPlainObject(raw?.python) && Object.hasOwn(raw.python, "packages");
	const get = <T>(key: string, fallback: T) => (values.has(key) ? (values.get(key) as T) : fallback);
	const source = get<"uv" | "project">("python.source", "uv");
	const packages = get<string[]>("python.packages", []);
	if (source === "project" && (hasPackages(global) || hasPackages(project))) {
		warnings.push('"python.packages" is ignored because python.source is "project"');
	} else if (!projectTrusted && hasPackages(project)) {
		warnings.push('Project "python.packages" is ignored because the project is not trusted');
	}
	return {
		config: {
			confirmEachCell: get("confirmEachCell", false),
			backgroundNotices: get("backgroundNotices", false),
			python: { source, version: get("python.version", DEFAULT_PYTHON_VERSION), defaultPackages: get("python.defaultPackages", true), packages },
			output: { maxBytes: get("output.maxBytes", DEFAULT_MAX_BYTES), maxLines: get("output.maxLines", DEFAULT_MAX_LINES) },
			piTools: { list: get("piTools.list", true), search: get("piTools.search", true) },
			prelude: { defaults: get("prelude.defaults", true), imports: get<string[]>("prelude.imports", []), prompt: get("prelude.prompt", true) },
			systemPrompt: {
				ipythonAfter: get<string[]>("systemPrompt.ipythonAfter", []),
				ipythonBefore: get<string[]>("systemPrompt.ipythonBefore", [...DEFAULT_IPYTHON_BEFORE]),
			},
		},
		errors,
		warnings,
	};
}

function readJsonObject(file: string, errors: string[]): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file}: cannot read: ${String(error)}`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		errors.push(`${file}: invalid JSON: ${(error as Error).message}`);
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		errors.push(`${file}: must contain a JSON object`);
		return undefined;
	}
	return parsed;
}

function collect(raw: Record<string, unknown>, file: string, values: Map<string, unknown>, errors: string[], allowPackages: boolean): void {
	const check = (key: string, value: unknown) => {
		if (key === "python.packages" && !allowPackages) return;
		const field = Object.hasOwn(FIELDS, key) ? FIELDS[key] : undefined;
		if (!field) errors.push(`${file}: unknown key "${key}"`);
		else if (!field.valid(value)) {
			const shown = JSON.stringify(value);
			errors.push(`${file}: "${key}" must be ${field.expected}, got ${key === "python.packages" ? redactPackageUrls(shown) : shown}`);
		} else if (key === "prelude.imports" || key === "python.packages") {
			const validate = key === "prelude.imports" ? validImports : validPackages;
			values.set(key, [...((values.get(key) as string[] | undefined) ?? []), ...validate(value as unknown[], file, errors)]);
		} else values.set(key, value);
	};
	for (const [key, value] of Object.entries(raw)) {
		if (!SECTIONS.has(key)) check(key, value);
		else if (!isPlainObject(value)) errors.push(`${file}: "${key}" must be an object`);
		else for (const [sub, subValue] of Object.entries(value)) check(`${key}.${sub}`, subValue);
	}
}

/** Entries that are single import statements; each other entry is reported and skipped. */
function validImports(entries: unknown[], file: string, errors: string[]): string[] {
	return entries.flatMap((entry, i) => {
		if (typeof entry === "string" && preludeStatementNames(entry)) return [entry.trim()];
		errors.push(`${file}: "prelude.imports[${i}]" must be ${IMPORT_EXPECTED}, got ${JSON.stringify(entry)}`);
		return [];
	});
}

/** Entries that are uv requirements; each other entry is reported and skipped. */
function validPackages(entries: unknown[], file: string, errors: string[]): string[] {
	return entries.flatMap((entry, i) => {
		const requirement = typeof entry === "string" ? entry.trim() : "";
		if (requirement && !requirement.startsWith("-")) return [requirement];
		errors.push(`${file}: "python.packages[${i}]" must be ${PACKAGE_EXPECTED}, got ${redactPackageUrls(JSON.stringify(entry))}`);
		return [];
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
