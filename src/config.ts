// Config: `<agentDir>/pi-ipython.json` (global) merged with `<cwd>/.pi/pi-ipython.json` (project).
// Project values win per key. An invalid file or value is reported and skipped, so defaults still apply.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PYTHON_VERSION } from "./kernel/bootstrap.ts";

export const CONFIG_FILE_NAME = "pi-ipython.json";

export interface PiIpythonConfig {
	confirmEachCell: boolean;
	python: { source: "uv" | "project"; version: string };
	output: { maxBytes: number; maxLines: number };
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
		valid: (v) => typeof v === "string" && /^\d+\.\d+(\.\d+)?$/.test(v),
		expected: 'a Python version like "3.13"',
	},
	"output.maxBytes": { valid: isPositiveInt, expected: "a positive integer" },
	"output.maxLines": { valid: isPositiveInt, expected: "a positive integer" },
};
const SECTIONS = new Set(["python", "output"]);

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
		const field = FIELDS[key];
		if (!field) errors.push(`${file}: unknown key "${key}"`);
		else if (!field.valid(value)) errors.push(`${file}: "${key}" must be ${field.expected}, got ${JSON.stringify(value)}`);
		else values.set(key, value);
	};
	for (const [key, value] of Object.entries(raw)) {
		if (!SECTIONS.has(key)) check(key, value);
		else if (!isPlainObject(value)) errors.push(`${file}: "${key}" must be an object`);
		else for (const [sub, subValue] of Object.entries(value)) check(`${key}.${sub}`, subValue);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
