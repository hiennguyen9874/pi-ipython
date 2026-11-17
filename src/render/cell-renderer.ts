// Simple TUI renderer for Cells: highlighted Python code and a compact result.
// The full Cell component port (Unharnessed's ipython-cell.ts) is v2.

import {
	type AgentToolResult,
	highlightCode,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
	truncateTail,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, getImageDimensions, imageFallback, Text } from "@earendil-works/pi-tui";
import type { IpythonToolDetails } from "../tool/ipython-tool.ts";

const CODE_PREVIEW_LINES = 10;
const OUTPUT_PREVIEW_LINES = 5;

type CellArgs = { code: string };
// pi does not export ToolRenderContext by name.
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** "ipython", then the Cell's code highlighted as Python; long code shows its first lines until expanded. */
export function renderCellCall(args: CellArgs, theme: Theme, context: Context): Component {
	const lines = highlightCode(typeof args?.code === "string" ? args.code : "", "python");
	const shown = context.expanded ? lines : lines.slice(0, CODE_PREVIEW_LINES);
	let text = `${theme.fg("toolTitle", theme.bold("ipython"))}\n${shown.join("\n")}`;
	if (shown.length < lines.length) text += `\n${expandHint(`${lines.length - shown.length} more lines`, theme, context)}`;
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}

/**
 * Output collapsed to its last lines until expanded, then the exception name and message.
 * The traceback is shown only when expanded.
 */
export function renderCellResult(
	result: AgentToolResult<IpythonToolDetails | undefined>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: Context,
): Component {
	const container = new Container();
	const add = (text: string) => container.addChild(new Text(text, 0, 0));
	if (isPartial) {
		add(theme.fg("muted", "Running..."));
		return container;
	}
	const d = result.details;
	// A thrown error leaves no Cell result (pi sets details to {}).
	if (!d?.status) {
		// The Cell did not run (refused, busy Kernel, Kernel failure): the reason is the content.
		add(theme.fg("error", result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")));
	} else {
		if (d.kernelRestarted) add(theme.fg("warning", "Kernel killed and restarted: earlier Python state is gone."));
		const parts: string[] = [];
		if (d.stdout) parts.push(fgLines(theme, "toolOutput", d.stdout));
		if (d.stderr) parts.push(fgLines(theme, "warning", d.stderr));
		if (d.result !== undefined) parts.push(fgLines(theme, "toolOutput", d.result));
		if (d.backgroundOutput) parts.push(fgLines(theme, "muted", `[background output]\n${d.backgroundOutput}`));
		const errorLine = d.error && (d.error.evalue ? `${d.error.ename}: ${d.error.evalue}` : d.error.ename);
		if (d.error && expanded) {
			// The traceback ends with the error line, which is drawn highlighted below.
			let traceback = trimNewline(d.error.traceback.join(""));
			if (errorLine && traceback.endsWith(errorLine)) traceback = traceback.slice(0, -errorLine.length).trimEnd();
			if (traceback) parts.push(fgLines(theme, "toolOutput", traceback));
		}
		// Details hold the untruncated output: draw at most pi's default limits.
		const body = truncateTail(parts.join("\n")).content;
		if (body) container.addChild(expanded ? new Text(body, 0, 0) : new TailPreview(body, theme, context));
		if (d.error) add(theme.fg("error", theme.bold(d.error.ename) + (d.error.evalue ? `: ${d.error.evalue}` : "")));
		if (d.status === "aborted") add(theme.fg("warning", "Cell aborted"));
		if (d.fullOutputPath) add(theme.fg("warning", `[Output truncated. Full output: ${d.fullOutputPath}]`));
	}
	// Images the terminal draws itself need no placeholder.
	if (!getCapabilities().images || !context.showImages) {
		for (const block of result.content) {
			if (block.type !== "image") continue;
			add(theme.fg("muted", imageFallback(block.mimeType, getImageDimensions(block.data, block.mimeType) ?? undefined)));
		}
	}
	return container;
}

const trimNewline = (s: string) => s.replace(/\n$/, "");

/** Colour each line on its own, so cutting or wrapping lines never drops the opening colour code. */
function fgLines(theme: Theme, color: Parameters<Theme["fg"]>[0], text: string): string {
	return trimNewline(text).split("\n").map((line) => theme.fg(color, line)).join("\n");
}

function expandHint(what: string, theme: Theme, context: Context): string {
	return `${theme.fg("muted", `... (${what},`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** The last visual lines of the output at the width it is drawn, after a hint to expand. */
class TailPreview implements Component {
	private cache?: { width: number; lines: string[] };
	constructor(private readonly text: string, private readonly theme: Theme, private readonly context: Context) {}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const { visualLines, skippedCount } = truncateToVisualLines(this.text, OUTPUT_PREVIEW_LINES, width, 0, "end");
		const lines = skippedCount > 0
			? [expandHint(`${skippedCount} earlier lines`, this.theme, this.context), ...visualLines]
			: visualLines;
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
