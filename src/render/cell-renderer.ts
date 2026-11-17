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
import { type Component, Container, getCapabilities, getImageDimensions, imageFallback, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
	if (!d?.status || d.stateLost) {
		// The Cell did not run or its Kernel died (refused, busy Kernel, Kernel failure): the reason is the content.
		if (d?.stateLost) add(theme.fg("warning", "Kernel replaced: earlier Python state is gone."));
		if (d?.stateLost && !expanded && d.stateLossCause !== undefined) {
			add(theme.fg("error", d.stateLossCause));
			add(theme.fg("warning", d.stateLossCellRan ? "Cell may have run; external effects may remain." : "Cell not run."));
			add(expandHint("full result", theme, context));
		} else {
			add(theme.fg("error", result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")));
		}
	} else {
		const lines: { text: string; color: Parameters<Theme["fg"]>[0] }[] = [];
		const append = (text: string, color: Parameters<Theme["fg"]>[0]) => {
			for (const line of trimNewline(text).split("\n")) lines.push({ text: line, color });
		};
		if (d.stdout) append(d.stdout, "toolOutput");
		if (d.stderr) append(d.stderr, "warning");
		if (d.result !== undefined) append(d.result, "toolOutput");
		if (d.backgroundOutput) append(`[background output]\n${d.backgroundOutput}`, "muted");
		const errorLine = d.error && (d.error.evalue ? `${d.error.ename}: ${d.error.evalue}` : d.error.ename);
		if (d.error && expanded) {
			// The traceback ends with the error line, which is drawn highlighted below.
			let traceback = trimNewline(d.error.traceback.join(""));
			if (errorLine && traceback.endsWith(errorLine)) traceback = traceback.slice(0, -errorLine.length).trimEnd();
			if (traceback) append(traceback, "toolOutput");
		}
		// Limit raw text, not ANSI styling, using the same limits as the model-facing result.
		const raw = lines.map((line) => line.text).join("\n");
		const body = truncateTail(raw, d.outputLimits).content;
		if (body) {
			const kept = body.split("\n");
			// Locate the raw tail, including partial lines and a discarded final newline.
			const firstLine = raw.slice(0, raw.lastIndexOf(body)).split("\n").length - 1;
			const colors = lines.slice(firstLine);
			const styled = kept.map((line, i) => theme.fg(colors[i]!.color, line)).join("\n");
			container.addChild(expanded ? new Text(styled, 0, 0) : new TailPreview(styled, theme, context));
		}
		if (d.error) {
			const message = truncateTail(d.error.evalue, d.outputLimits).content;
			const text = (theme.bold(d.error.ename) + (message ? `: ${message}` : ""))
				.split("\n").map((line) => theme.fg("error", line)).join("\n");
			const heading = theme.fg("error", theme.bold(d.error.ename));
			container.addChild(expanded ? new Text(text, 0, 0) : new TailPreview(text, theme, context, heading));
		}
		if (d.status === "aborted") add(theme.fg("warning", "Cell aborted"));
		if (d.outputWarning) add(theme.fg("warning", d.outputWarning));
		else if (d.fullOutputPath) add(theme.fg("warning", `[Output truncated. Full output: ${d.fullOutputPath}]`));
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

function expandHint(what: string, theme: Theme, context: Context): string {
	return `${theme.fg("muted", `... (${what},`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** The last visual lines of the output at the width it is drawn, after a hint to expand. */
class TailPreview implements Component {
	private cache?: { width: number; lines: string[] };
	constructor(
		private readonly text: string,
		private readonly theme: Theme,
		private readonly context: Context,
		private readonly heading?: string,
	) {}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const { visualLines, skippedCount } = truncateToVisualLines(this.text, OUTPUT_PREVIEW_LINES, width, 0, "end");
		const lines = skippedCount > 0
			? [
				// Error names stay visible when their message's first lines are hidden.
				...(this.heading ? new Text(this.heading, 0, 0).render(width) : []),
				truncateToWidth(expandHint(`${skippedCount} earlier lines`, this.theme, this.context), width, "..."),
				...visualLines,
			]
			: visualLines;
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
