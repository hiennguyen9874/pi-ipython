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
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type ExtensionToolContext,
	formatSize,
	type ToolDefinition,
	type TruncationOptions,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CellResult, type KernelClient, KernelBusyError } from "../kernel/client.ts";
import { renderCellCall, renderCellResult } from "../render/cell-renderer.ts";

export const IPYTHON_TOOL_NAME = "ipython";

/** The repo-owned `pi` module (Bridged calls), loaded from its file so the vendored runtime stays unchanged. */
const PI_MODULE_PATH = fileURLToPath(new URL("../bridge/pi.py", import.meta.url));

/** Run once in every new Kernel: binds `bash`, `asyncio`, and `pi` into the namespace. */
export const KERNEL_BOOTSTRAP_CODE = `
import asyncio
import os as _pi_ipython_os

_pi_ipython_os.environ["NO_COLOR"] = "1"

import rlm as _pi_ipython_rlm
bash = _pi_ipython_rlm.bash

import importlib.util as _pi_ipython_importlib_util
_pi_ipython_spec = _pi_ipython_importlib_util.spec_from_file_location("pi", ${JSON.stringify(PI_MODULE_PATH)})
pi = _pi_ipython_importlib_util.module_from_spec(_pi_ipython_spec)
_pi_ipython_spec.loader.exec_module(pi)
`.trim();

// Busy-Kernel choice, from Unharnessed's pre-Rust host (core/tools/ipython.ts).
const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted Python cell is still running",
	"An interrupt was sent, but the previous cell has not stopped yet. A new command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts the kernel and loses in-memory variables, imports, and running tasks.",
].join("\n");
const KERNEL_KILLED_CAUSE = "The user killed the previous Kernel because an interrupted Cell kept running.";

/** The State-loss notice: one text for every Kernel replacement. Its cause follows it as plain text. */
export const STATE_LOST_NOTICE = [
	"<ipython_state_lost>",
	"The Python Kernel was replaced, so all Python state from earlier Cells is gone: variables, functions, imports, async tasks, and open resources no longer exist. Recreate what you need before using it.",
	"</ipython_state_lost>",
].join("\n");
export const CELL_NOT_RUN_AFTER_STATE_LOSS = "Cell not run: resubmit it once the state it needs exists.";

export const CELL_REJECTED_ERROR = "Cell rejected by user: it did not run.";
export const CONFIRM_NO_UI_ERROR =
	"Cell not run: confirmEachCell is on, but there is no UI to ask the user for approval.";

const ipythonSchema = Type.Object({
	code: Type.String({ description: "Python code to run in the persistent Kernel." }),
});

export interface IpythonToolDetails extends CellResult {
	/** Set when the text was truncated: the temp file holding the full text. */
	fullOutputPath?: string;
	/** Truncation notice, including a failed attempt to save the full output. */
	outputWarning?: string;
	/** Raw-text limits shared by model output and the TUI renderer. */
	outputLimits?: TruncationOptions;
	/** True when this result carries the State-loss notice. */
	stateLost?: boolean;
}

export interface IpythonToolOptions {
	getKernel: () => KernelClient;
	/** Kill the Kernel; the next `getKernel()` returns a fresh one. */
	killKernel: () => Promise<void>;
	getOutputLimits?: () => TruncationOptions;
	/** When true, the user approves each Cell's code before it runs. */
	getConfirmEachCell?: () => boolean;
	/** The cause of a Kernel replacement the model was not told about yet, consuming it. */
	takeStateLoss?: () => string | undefined;
	/** Answers the running Cell's host requests (Bridged calls) with this call's context and signal. */
	answerHostRequest?: (data: Record<string, unknown>, ctx: ExtensionToolContext, signal: AbortSignal | undefined) => Promise<unknown>;
}

/** The State-loss notice as a Cell's error result; a Cell that did not run says so. */
function stateLostResult(cause: string, cellRan = false) {
	const text = [STATE_LOST_NOTICE, cause, ...(cellRan ? [] : [CELL_NOT_RUN_AFTER_STATE_LOSS])].join("\n\n");
	const details: IpythonToolDetails = {
		stdout: "",
		stderr: "",
		images: [],
		backgroundOutput: "",
		status: "error",
		durationMs: 0,
		stateLost: true,
	};
	return { content: [{ type: "text" as const, text }], details, isError: true };
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
): { text: string; fullOutputPath?: string; outputWarning?: string } {
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
		const outputWarning = `[Output truncated (${formatSize(t.totalBytes)} total): showing ${shown}. Full output could not be saved: ${reason}]`;
		return { text: `${content}\n\n${outputWarning}`, outputWarning };
	}
	const outputWarning = `[Output truncated (${formatSize(t.totalBytes)} total): showing ${shown}. Full output: ${fullOutputPath}]`;
	return { text: `${content}\n\n${outputWarning}`, fullOutputPath, outputWarning };
}

export function createIpythonTool({
	getKernel,
	killKernel,
	getOutputLimits = () => ({}),
	getConfirmEachCell = () => false,
	takeStateLoss = () => undefined,
	answerHostRequest,
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
		// Cells can discover/call any Pi tool: let MCP finish registration before Python runs.
		reachesTools: () => "all",
		// Other active tools are there only for Bridged calls: the model sees only ipython.
		prepareLoadout: (loadout) => ({
			hiddenDeclarations: loadout.declared.map((tool) => tool.name).filter((name) => name !== IPYTHON_TOOL_NAME),
		}),
		renderCall: renderCellCall,
		renderResult: renderCellResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Never run a Cell written against Python state that is already gone (ADR 0003).
			const lostCause = takeStateLoss();
			if (lostCause !== undefined) return stateLostResult(lostCause);
			if (getConfirmEachCell()) {
				if (!ctx.hasUI) throw new Error(CONFIRM_NO_UI_ERROR);
				if (!(await ctx.ui.confirm("Run this Python Cell?", params.code, { signal }))) throw new Error(CELL_REJECTED_ERROR);
			}
			let r: CellResult;
			for (;;) {
				// A dialog may have outlived the Kernel whose state this Cell assumes.
				const cause = takeStateLoss();
				if (cause !== undefined) return stateLostResult(cause);
				try {
					r = await getKernel().execute(
						params.code,
						signal,
						answerHostRequest && ((data) => answerHostRequest(data, ctx, signal)),
					);
					break;
				} catch (error) {
					if (!(error instanceof KernelBusyError) || signal?.aborted) {
						// This Cell's Kernel died under it: its own error tells the model. Never replay it.
						const cause = takeStateLoss();
						if (cause !== undefined) return stateLostResult(cause, true);
						throw error;
					}
					// Like the branch-switch choice, only the TUI prompts; elsewhere the model gets the busy error.
					const choice = ctx.mode === "tui" && ctx.hasUI
						? await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], { signal })
						: undefined;
					if (choice === BUSY_KERNEL_WAIT_CHOICE) continue;
					if (choice !== BUSY_KERNEL_KILL_CHOICE) throw error;
					await killKernel();
					takeStateLoss();
					// The Cell was written for the killed Kernel's state (ADR 0003).
					return stateLostResult(KERNEL_KILLED_CAUSE);
				}
			}
			const outputLimits = getOutputLimits();
			const truncated = truncateCellText(formatCellResult(r), outputLimits, r.backgroundOutput);
			const images: ImageContent[] = r.images.map((i) => ({ type: "image", ...i }));
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: truncated.text }, ...images];
			return {
				content,
				details: { ...r, fullOutputPath: truncated.fullOutputPath, outputWarning: truncated.outputWarning, outputLimits },
				isError: r.status !== "ok",
			};
		},
	};
}
