// BM25 ranking for `pi.search`: Pi tools ranked by their name, description, schema, and namespace.
//
// Ported from pi's tool search (packages/coding-agent/src/extensions/tool-search/tool.ts: `tokenize`,
// `createToolSearchDocument`, `Bm25Ranker`), which the package root does not export, and `resolveSchemaRef`
// from packages/codemode/src/declarations.ts.
// Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const DEFAULT_SEARCH_LIMIT = 8;

/** A tool as the ranker reads it; `namespaceText` is the namespace name, description, and instructions. */
export interface ToolSearchDocument {
	name: string;
	text: string;
	namespaceText?: string;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
	"is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Unicode word segmentation with identifier boundaries and English stop words/singular forms. */
function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split; plain ASCII splits into the same words at spaces.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A local JSON pointer (`#/$defs/x`) resolved in `root`, or undefined. */
function resolveSchemaRef(ref: string, root: unknown): unknown {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			// Schemas come from tools and MCP servers: a malformed escape names nothing instead of failing the caller.
			return undefined;
		}
		const key = decoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isObject(current) || !(key in current)) return undefined;
		current = current[key];
	}
	return current;
}

/**
 * Schema descriptions and property names, recursively, following local `$ref`s into `root`. `seen` holds the
 * subschemas already reached through a reference, so recursive and shared definitions are read once.
 */
function schemaText(schema: unknown, root: unknown, parts: string[], seen: Set<unknown>): void {
	if (!isObject(schema)) return;
	if (typeof schema.$ref === "string") {
		const target = resolveSchemaRef(schema.$ref, root);
		if (isObject(target) && !seen.has(target)) {
			seen.add(target);
			schemaText(target, root, parts, seen);
		}
	}
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, root, parts, seen);
		}
	}
	schemaText(schema.items, root, parts, seen);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, root, parts, seen);
	}
}

/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
export function createToolSearchDocument(tool: Pick<ToolInfo, "name" | "description" | "parameters" | "namespace">): ToolSearchDocument {
	const parts = [tool.description];
	schemaText(tool.parameters, tool.parameters, parts, new Set([tool.parameters]));
	const namespace = tool.namespace;
	const namespaceText = namespace
		? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
		: "";
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" "), namespaceText };
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9_$]/g, "_");
}

/** Whether the whole query is the tool's name: its full name or a suffix after a `__` separator. */
function isExactNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}

function indexDocument(document: ToolSearchDocument) {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]!))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

/** A query term in the name counts this many times its IDF: more than any number of description mentions. */
const NAME_WEIGHT = 3;
/** A query term in the namespace counts this many times its IDF: it helps find the server, not the tool in it. */
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields. Tools matching more
 * query terms rank first; a name match beats description mentions; a tool whose whole local name is in the
 * query gets a bonus; a query that is exactly a tool's name ranks that tool first. Ties keep document order.
 */
export class Bm25Ranker {
	constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): { name: string; score: number }[] {
		const queryTerms = new Set(tokenize(query));
		if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
		const indexed = documents.map(indexDocument);
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		const idf = new Map([...queryTerms].map((term) => {
			const frequency = indexed.filter((document) =>
				document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term)).length;
			return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
		}));
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		const exactQuery = normalizeName(query);
		const matches: { name: string; score: number; covered: number; exact: boolean }[] = [];
		for (const document of indexed) {
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			let score = 0;
			let covered = 0;
			for (const term of queryTerms) {
				const count = document.textCounts.get(term) ?? 0;
				const weight = (document.nameTerms.has(term) ? NAME_WEIGHT : 0)
					+ (document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0)
					+ (count * (this.k1 + 1)) / (count + norm);
				if (weight > 0) covered++;
				score += (idf.get(term) ?? 0) * weight;
			}
			if (score === 0) continue;
			const local = document.localNameTerms;
			if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
		}
		return matches
			.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
			.slice(0, limit)
			.map(({ name, score }) => ({ name, score }));
	}
}
