// Listed Pi tools: the part of the `ipython` description that names callable `direct` and `codemode` tools.
//
// The round-robin budget selection and namespace markers are ported from pi's codemode tool
// (packages/coding-agent/src/extensions/codemode/tool.ts, `selectCatalog`, `createCodemodeDescription`).
// Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import type { ToolLoadout, ToolNamespace } from "@earendil-works/pi-coding-agent";

/** Fixed budget for the listed tool entries, in estimated tokens. */
export const PI_TOOL_LIST_BUDGET = 3000;
const CHARS_PER_TOKEN = 4;

interface Entry {
	name: string;
	line: string;
	cost: number;
}

interface Group {
	namespace: ToolNamespace | undefined;
	entries: Entry[];
}

/**
 * The listing appended to the `ipython` description, or undefined when no callable tool has `direct` or
 * `codemode` exposure. `bridged` holds the names Cells may call; `deferred` tools are never listed, so
 * tools registering late with that exposure (MCP by default) leave the description unchanged.
 */
export function listPiTools(loadout: ToolLoadout, bridged: ReadonlySet<string>): string | undefined {
	const groups = new Map<string, Group>([["", { namespace: undefined, entries: [] }]]);
	let count = 0;
	for (const tool of loadout.callable) {
		const exposure = loadout.getExposure(tool.name);
		if (!bridged.has(tool.name) || (exposure !== "direct" && exposure !== "codemode")) continue;
		const namespace = loadout.getNamespace(tool.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const summary = tool.description.trim().split("\n")[0]?.trim();
		const line = summary ? `- \`${tool.name}\`: ${summary}` : `- \`${tool.name}\``;
		group.entries.push({ name: tool.name, line, cost: Math.ceil(line.length / CHARS_PER_TOKEN) });
		count++;
	}
	if (count === 0) return undefined;

	// Tools without a namespace first, then namespaces by name.
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name)
	);
	const shown = selectEntries(ordered, PI_TOOL_LIST_BUDGET);
	const sections = [
		"Pi tools you can call from Python with `await pi.tool(name, args)`; `await pi.describe(name)` shows a tool's parameters. This list may be incomplete: `await pi.tools()` lists every callable tool.",
	];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		const lines = visible.map((entry) => entry.line);
		if (namespace) {
			// Only tools that did not fit the budget are counted as not listed.
			const marker = visible.length === entries.length
				? ""
				: visible.length === 0
				? " (tools not listed)"
				: " (some tools not listed)";
			const description = namespace.description?.trim();
			lines.unshift(`## ${namespace.name}${marker}${description ? `\n${description}` : ""}`);
		}
		if (lines.length > 0) sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

/**
 * Pick the entries that fit the budget: in each round every group places its cheapest remaining entry; a
 * group whose next entry does not fit drops out while the others continue.
 */
function selectEntries(groups: readonly Group[], budget: number): Set<string> {
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0]!;
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}
