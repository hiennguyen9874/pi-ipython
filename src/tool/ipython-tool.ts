// The model-facing `ipython` tool: runs one Cell in the session's Kernel and shapes the result.
//
// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa,
// packages/coding-agent/src/core/tools/ipython.ts), rebuilt on pi.registerTool.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatSize, type ToolDefinition, type TruncationOptions, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CellResult, type KernelClient, KernelBusyError } from "../kernel/client.ts";

export const IPYTHON_TOOL_NAME = "ipython";

/** Run once in every new Kernel: binds `bash` and `mcp` into the namespace. */
export const KERNEL_BOOTSTRAP_CODE = `
import asyncio
import os as _pi_ipython_os

_pi_ipython_os.environ["NO_COLOR"] = "1"

import rlm as _pi_ipython_rlm
bash = _pi_ipython_rlm.bash
import rlm.mcp as mcp
`.trim();

// Busy-Kernel choice, from Unharnessed's pre-Rust host (core/tools/ipython.ts).
const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted Python cell is still running",
	"An interrupt was sent, but the previous cell has not stopped yet. A new command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables, imports, and running tasks.",
].join("\n");
export const KERNEL_RESTART_NOTICE = [
	"<ipython_kernel_reset>",
	"The previous Python kernel was killed because an interrupted cell kept running. Variables, imports, async tasks, and open resources from that kernel are no longer available; recreate them before using them.",
	"</ipython_kernel_reset>",
].join("\n");

export const CELL_REJECTED_ERROR = "Cell rejected by user: it did not run.";
export const CONFIRM_NO_UI_ERROR =
	"Cell not run: confirmEachCell is on, but there is no UI to ask the user for approval.";

const ipythonSchema = Type.Object({
	code: Type.String({ description: "Python code to run in the persistent Kernel." }),
});

export interface IpythonToolDetails extends CellResult {
	/** Set when the text was truncated: the temp file holding the full text. */
	fullOutputPath?: string;
	/** True when the user killed a busy Kernel before this Cell ran. */
	kernelRestarted?: boolean;
}

export interface IpythonToolOptions {
	getKernel: () => KernelClient;
	/** Kill the Kernel; the next `getKernel()` returns a fresh one. */
	killKernel: () => Promise<void>;
	getOutputLimits?: () => TruncationOptions;
	/** When true, the user approves each Cell's code before it runs. */
	getConfirmEachCell?: () => boolean;
}

/** Model-facing text: stdout, then stderr (labelled), then the trailing expression's repr, then the traceback. */
export function formatCellResult(r: CellResult): string {
	const parts: string[] = [];
	if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
	if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
	if (r.result !== undefined) parts.push(r.result);
	if (r.error) {
		const traceback = r.error.traceback.join("").replace(/\n$/, "");
		parts.push(traceback || `${r.error.ename}: ${r.error.evalue}`);
	}
	if (r.status === "aborted") parts.push("[Cell aborted]");
	if (r.backgroundOutput) parts.push(`[background output]\n${r.backgroundOutput.replace(/\n$/, "")}`);
	return parts.join("\n") || "(no output)";
}

/** Keep the tail within the limits (tracebacks and results come last); spill the full text to a temp file. */
export function truncateCellText(
	text: string,
	limits: TruncationOptions,
	backgroundOutput = "",
): { text: string; fullOutputPath?: string } {
	const t = truncateTail(text, limits);
	if (!t.truncated) return { text };
	let content = t.content;
	let shown = t.lastLinePartial
		? `the last ${formatSize(t.outputBytes)} of the last line`
		: `the last ${t.outputLines} of ${t.totalLines} lines`;
	const heading = "[background output]";
	const background = backgroundOutput.replace(/\n$/, "");
	const backgroundStart = text.length - background.length - heading.length - 1;
	if (backgroundOutput && text.length - content.length > backgroundStart) {
		// The tail starts inside the background section: restore its attribution, reserving space.
		const tail = truncateTail(background, {
			maxLines: Math.max(0, t.maxLines - 1),
			maxBytes: Math.max(0, t.maxBytes - Buffer.byteLength(heading) - 1),
		});
		content = tail.content ? `${heading}\n${tail.content}` : heading;
		shown = `the tail of background output (${formatSize(tail.outputBytes)})`;
	}
	const fullOutputPath = join(tmpdir(), `pi-ipython-${randomUUID()}.log`);
	try {
		writeFileSync(fullOutputPath, text, { mode: 0o600, flag: "wx" });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			text: `${content}\n\n[Output truncated (${formatSize(t.totalBytes)} total): showing ${shown}. Full output could not be saved: ${reason}]`,
		};
	}
	return {
		text: `${content}\n\n[Output truncated (${formatSize(t.totalBytes)} total): showing ${shown}. Full output: ${fullOutputPath}]`,
		fullOutputPath,
	};
}

export function createIpythonTool({
	getKernel,
	killKernel,
	getOutputLimits = () => ({}),
	getConfirmEachCell = () => false,
}: IpythonToolOptions): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	return {
		name: IPYTHON_TOOL_NAME,
		label: "ipython",
		description:
			"Run Python code in a persistent Python Kernel. Variables, functions, and imports persist between calls. Top-level `await` works. The output contains stdout, stderr, the repr of the trailing expression, and errors with tracebacks. Long output is truncated to its tail, with the full text saved to a temp file. Images emitted with `from rlm.repl import emit; emit({'image/png': base64_str})` are returned as images. Output from background threads, tasks, and subprocesses is reported under [background output] in the next result.",
		promptSnippet: "ipython - persistent Python Kernel for code, data, and state",
		parameters: ipythonSchema,
		// One Kernel runs one Cell at a time.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (getConfirmEachCell()) {
				if (!ctx.hasUI) throw new Error(CONFIRM_NO_UI_ERROR);
				if (!(await ctx.ui.confirm("Run this Python Cell?", params.code, { signal }))) throw new Error(CELL_REJECTED_ERROR);
			}
			let kernelRestarted = false;
			let r: CellResult;
			for (;;) {
				try {
					r = await getKernel().execute(params.code, signal);
					break;
				} catch (error) {
					if (!(error instanceof KernelBusyError) || signal?.aborted) {
						if (kernelRestarted) {
							const reason = error instanceof Error ? error.message : String(error);
							throw new Error(`${KERNEL_RESTART_NOTICE}\n\n${reason}`, { cause: error });
						}
						throw error;
					}
					// Like the branch-switch choice, only the TUI prompts; elsewhere the model gets the busy error.
					const choice = ctx.mode === "tui" && ctx.hasUI
						? await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], { signal })
						: undefined;
					if (choice === BUSY_KERNEL_WAIT_CHOICE) continue;
					if (choice !== BUSY_KERNEL_KILL_CHOICE) throw error;
					await killKernel();
					kernelRestarted = true;
				}
			}
			const truncated = truncateCellText(formatCellResult(r), getOutputLimits(), r.backgroundOutput);
			// Prepended after truncation, so a long output cannot cut the notice off.
			const text = kernelRestarted ? `${KERNEL_RESTART_NOTICE}\n\n${truncated.text}` : truncated.text;
			const images: ImageContent[] = r.images.map((i) => ({ type: "image", ...i }));
			const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
			return {
				content,
				details: { ...r, fullOutputPath: truncated.fullOutputPath, kernelRestarted },
				isError: r.status !== "ok",
			};
		},
	};
}
