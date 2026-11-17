// Host side of Bridged calls: which Pi tools a Cell may call, and how a call's outcome reaches Python
// (`src/bridge/pi.py` sends the `pi.tool` host requests answered here).

import type { ExtensionToolContext, ToolInfo } from "@earendil-works/pi-coding-agent";

export const PI_TOOL_REQUEST = "pi.tool";

type ToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/**
 * Pi tools a Cell may call: every registered tool except `ipython`, `hidden` and `model-only` ones
 * (pi never lets tools call those), tools that reach other tools (`codemode`, `tool_search`), and pi's
 * built-ins, which Python replaces.
 */
export function bridgedTools(tools: readonly ToolInfo[], ipythonName: string): ToolInfo[] {
	return tools.filter((tool) =>
		tool.name !== ipythonName
		&& tool.exposure !== "hidden"
		&& tool.exposure !== "model-only"
		&& !tool.reachesTools
		&& tool.sourceInfo.source !== "builtin"
	);
}

/**
 * Answer one host request of a running Cell. Resolves with the value Python receives; rejects with the
 * error text `pi.ToolError` carries.
 */
export async function answerHostRequest(
	data: Record<string, unknown>,
	callable: ReadonlySet<string>,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	if (data.type !== PI_TOOL_REQUEST) throw new Error(`host request ${String(data.type)} is not supported by pi-ipython`);
	const { name, args } = data;
	if (typeof name !== "string") throw new Error("pi.tool name must be a string");
	// Same text as pi's unknown tool, so an excluded tool is indistinguishable from a missing one.
	if (!callable.has(name)) throw new Error(`Tool ${name} not found`);
	const outcome = await ctx.executeTool(name, args ?? {}, { signal });
	return toPythonValue(name, outcome, ctx.tools.find((tool) => tool.name === name)?.outputSchema !== undefined);
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
