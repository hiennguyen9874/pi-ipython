// Host side of Bridged calls: which Pi tools a Cell may call, and how a call's outcome reaches Python
// (`src/bridge/pi.py` sends the `pi.tool`, `pi.tools`, `pi.search`, `pi.describe`, and `pi.describe_namespace`
// host requests answered here).

import type { ExtensionToolContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Bm25Ranker, createToolSearchDocument } from "./tool-search.ts";

export const PI_TOOL_REQUEST = "pi.tool";
export const PI_TOOLS_REQUEST = "pi.tools";
export const PI_SEARCH_REQUEST = "pi.search";
export const PI_DESCRIBE_REQUEST = "pi.describe";
export const PI_DESCRIBE_NAMESPACE_REQUEST = "pi.describe_namespace";

type ToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/**
 * Pi tools a Cell may call: every registered tool except `ipython`, `hidden` and `model-only` ones
 * (pi never lets tools call those), tools that reach other tools (`codemode`, `tool_search`), and pi's
 * built-in file/shell tools, which Python replaces. Tools from `builtin:mcp` remain callable.
 */
export function bridgedTools(tools: readonly ToolInfo[], ipythonName: string): ToolInfo[] {
	return tools.filter((tool) =>
		tool.name !== ipythonName
		&& tool.exposure !== "hidden"
		&& tool.exposure !== "model-only"
		&& !tool.reachesTools
		&& (tool.sourceInfo.source !== "builtin" || tool.sourceInfo.path === "builtin:mcp")
	);
}

/**
 * Answer one host request of a running Cell. Resolves with the value Python receives; rejects with the
 * error text `pi.ToolError` carries. `search` is whether `pi.search` is on (`piTools.search`).
 */
export async function answerHostRequest(
	data: Record<string, unknown>,
	callable: readonly ToolInfo[],
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	search: boolean,
): Promise<unknown> {
	if (data.type === PI_TOOLS_REQUEST) return callable.map(toolEntry);
	if (data.type === PI_SEARCH_REQUEST) {
		if (!search) throw new Error("pi.search is turned off (piTools.search: false)");
		const { query, limit } = data;
		if (typeof query !== "string" || query.trim() === "") throw new Error("query must be a non-empty string");
		if (!Number.isInteger(limit) || (limit as number) <= 0) throw new Error("limit must be a positive integer");
		const matches = new Bm25Ranker().rank(query, callable.map(createToolSearchDocument), limit as number);
		return matches.map((match) => toolEntry(callable.find((tool) => tool.name === match.name)!));
	}
	if (data.type === PI_DESCRIBE_NAMESPACE_REQUEST) {
		const { name } = data;
		if (typeof name !== "string") throw new Error(`${data.type} name must be a string`);
		// Only namespaces of callable tools, matched by name or alias as codemode's describeNamespace().
		const namespace = callable
			.map((tool) => tool.namespace)
			.find((candidate) => candidate && (candidate.name === name || candidate.aliases?.includes(name)));
		if (!namespace) throw new Error(`Namespace ${name} not found`);
		return {
			name: namespace.name,
			description: namespace.description ?? null,
			instructions: namespace.instructions ?? null,
		};
	}
	if (data.type !== PI_TOOL_REQUEST && data.type !== PI_DESCRIBE_REQUEST) {
		throw new Error(`host request ${String(data.type)} is not supported by pi-ipython`);
	}
	const { name, args } = data;
	if (typeof name !== "string") throw new Error(`${data.type} name must be a string`);
	const tool = callable.find((candidate) => candidate.name === name);
	// Same text as pi's unknown tool, so an excluded tool is indistinguishable from a missing one.
	if (!tool) throw new Error(`Tool ${name} not found`);
	if (data.type === PI_DESCRIBE_REQUEST) {
		return {
			name,
			description: tool.description,
			namespace: tool.namespace?.name ?? null,
			parameters: tool.parameters,
			guidelines: [...(tool.promptGuidelines ?? [])],
			// `ToolInfo` carries no output schema; the session's tools do.
			returns: outputSchema(ctx, name) ?? "str",
		};
	}
	const outcome = await ctx.executeTool(name, args ?? {}, { signal });
	return toPythonValue(name, outcome, outputSchema(ctx, name) !== undefined);
}

/** A `pi.tools()` entry: name, first description line, and namespace name or null. */
function toolEntry(tool: ToolInfo) {
	return {
		name: tool.name,
		description: tool.description.trim().split("\n")[0] ?? "",
		namespace: tool.namespace?.name ?? null,
	};
}

function outputSchema(ctx: ExtensionToolContext, name: string): unknown {
	return ctx.tools.find((tool) => tool.name === name)?.outputSchema;
}

/** As codemode: `structuredContent` for tools with an output schema, else the text; images become a marker. */
function toPythonValue(name: string, { result, isError }: ToolOutcome, structured: boolean): unknown {
	const blocks = result.content ?? [];
	const images = blocks.filter((block) => block.type === "image").length;
	const text = [
		...blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
		...(images > 0 ? [`[${images} image(s) omitted]`] : []),
	].join("\n");
	if (isError) throw new Error(text || `Tool ${name} failed`);
	if (structured && result.structuredContent !== undefined) return result.structuredContent;
	return text;
}
