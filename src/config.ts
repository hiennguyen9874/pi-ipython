// Config: `<agentDir>/pi-ipython.json` (global) merged with `<cwd>/.pi/pi-ipython.json` (project).
// Project values win per key. An invalid file or value is reported and skipped, so defaults still apply.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PYTHON_VERSION } from "./kernel/bootstrap.ts";
import { DEFAULT_PRELUDE, preludeStatementNames } from "./kernel/prelude.ts";

export const CONFIG_FILE_NAME = "pi-ipython.json";

export interface PiIpythonConfig {
	confirmEachCell: boolean;
	python: { source: "uv" | "project"; version: string };
	output: { maxBytes: number; maxLines: number };
	piTools: { list: boolean; search: boolean };
	/** `imports` concatenates global then project entries instead of the project winning. */
	prelude: { defaults: boolean; imports: string[]; prompt: boolean };
}

/** The import statements the Kernel bootstrap runs: the defaults (unless turned off), then the configured imports. */
export function effectivePrelude(config: PiIpythonConfig): string[] {
	return [...new Set([...(config.prelude.defaults ? DEFAULT_PRELUDE : []), ...config.prelude.imports])];
}

export interface LoadedConfig {
	config: PiIpythonConfig;
	/** One message per problem, naming the file and the key. */
	errors: string[];
}

const isPositiveInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

/** Every supported key (dotted path), with its validator and a description of valid values. */
const FIELDS: Record<string, { valid: (v: unknown) => boolean; expected: string }> = {
	confirmEachCell: { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"python.source": { valid: (v) => v === "uv" || v === "project", expected: '"uv" or "project"' },
	"python.version": {
		valid: (v) => {
			if (typeof v !== "string" || !/^\d+\.\d+(\.\d+)?$/.test(v)) return false;
			const [major, minor] = v.split(".").map(Number);
			return major! > 3 || (major === 3 && minor! >= 11);
		},
		expected: 'a Python version >=3.11 like "3.13"',
	},
	"output.maxBytes": { valid: isPositiveInt, expected: "a positive integer" },
	"output.maxLines": { valid: isPositiveInt, expected: "a positive integer" },
	"piTools.list": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"piTools.search": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"prelude.defaults": { valid: (v) => typeof v === "boolean", expected: "true or false" },
	"prelude.imports": { valid: Array.isArray, expected: "an array of import statements" },
	"prelude.prompt": { valid: (v) => typeof v === "boolean", expected: "true or false" },
};
const SECTIONS = new Set(["python", "output", "piTools", "prelude"]);
const IMPORT_EXPECTED = 'one "import …" or "from … import …" statement (absolute, without "*")';

export function configPaths(cwd: string, agentDir = getAgentDir()): { global: string; project: string } {
	return {
		global: path.join(agentDir, CONFIG_FILE_NAME),
		project: path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
	};
}

export function loadConfig(cwd: string, agentDir = getAgentDir()): LoadedConfig {
	const errors: string[] = [];
	const values = new Map<string, unknown>();
	const paths = configPaths(cwd, agentDir);
	for (const file of [paths.global, paths.project]) {
		const raw = readJsonObject(file, errors);
		if (raw) collect(raw, file, values, errors);
	}
	const get = <T>(key: string, fallback: T) => (values.has(key) ? (values.get(key) as T) : fallback);
	return {
		config: {
			confirmEachCell: get("confirmEachCell", false),
			python: { source: get("python.source", "uv"), version: get("python.version", DEFAULT_PYTHON_VERSION) },
			output: { maxBytes: get("output.maxBytes", DEFAULT_MAX_BYTES), maxLines: get("output.maxLines", DEFAULT_MAX_LINES) },
			piTools: { list: get("piTools.list", true), search: get("piTools.search", true) },
			prelude: { defaults: get("prelude.defaults", true), imports: get<string[]>("prelude.imports", []), prompt: get("prelude.prompt", true) },
		},
		errors,
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

function collect(raw: Record<string, unknown>, file: string, values: Map<string, unknown>, errors: string[]): void {
	const check = (key: string, value: unknown) => {
		const field = Object.hasOwn(FIELDS, key) ? FIELDS[key] : undefined;
		if (!field) errors.push(`${file}: unknown key "${key}"`);
		else if (!field.valid(value)) errors.push(`${file}: "${key}" must be ${field.expected}, got ${JSON.stringify(value)}`);
		else if (key === "prelude.imports") values.set(key, [...((values.get(key) as string[] | undefined) ?? []), ...validImports(value as unknown[], file, errors)]);
		else values.set(key, value);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
