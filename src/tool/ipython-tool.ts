// The model-facing `ipython` tool: runs one Cell in the session's Kernel and shapes the result.
//
// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa,
// packages/coding-agent/src/core/tools/ipython.ts), rebuilt on pi.registerTool.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { randomUUID } from "node:crypto";
import { closeSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type AgentToolUpdateCallback,
	type ExtensionToolContext,
	formatSize,
	type ToolDefinition,
	type ToolLoadout,
	type TruncationOptions,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CellOutput, type CellResult, disposeCellOutput, type KernelClient, KernelBusyError } from "../kernel/client.ts";
import { countNewlines, OutputBuffer, writeAll } from "../kernel/output-buffer.ts";
import { preludeCode } from "../kernel/prelude.ts";
import { renderCellCall, renderCellResult } from "../render/cell-renderer.ts";

export const IPYTHON_TOOL_NAME = "ipython";

/** The repo-owned `pi` module (Bridged calls), loaded from its file so the vendored runtime stays unchanged. */
const PI_MODULE_PATH = fileURLToPath(new URL("../bridge/pi.py", import.meta.url));

/** Run once in every new Kernel: binds `bash`, `asyncio`, `pi`, and the prelude's names into the namespace. */
export function kernelBootstrapCode(prelude: readonly string[] = []): string {
	return [KERNEL_BOOTSTRAP_CODE, preludeCode(prelude)].filter(Boolean).join("\n\n");
}

const KERNEL_BOOTSTRAP_CODE = `
import asyncio
import os as _pi_ipython_os
import sys as _pi_ipython_sys

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
	"Python state from earlier Cells is not available to subsequent Cells. Recreate variables, functions, imports, and handles before using them. Tasks tied to the old Kernel may have stopped. Files, subprocesses, and other external effects may still exist; check before repeating actions.",
	"</ipython_state_lost>",
].join("\n");
export const CELL_NOT_RUN_AFTER_STATE_LOSS = "Cell not run: resubmit it once the state it needs exists.";

export const CELL_REJECTED_ERROR = "Cell rejected by user: it did not run.";
export const CONFIRM_NO_UI_ERROR =
	"Cell not run: confirmEachCell is on, but there is no UI to ask the user for approval.";

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python code to run in the persistent Kernel. Use raw Python strings for regexes and shell commands with literal backslashes, for example " +
			"`re.search(r'\\.', text)` or `await bash(r\"rg 'LetterBox\\(' .\")`. Use `rf'...'` when interpolating, or double backslashes in a non-raw string.",
	}),
});

export interface IpythonToolDetails extends Omit<CellResult, "output"> {
	/** Set when the text was truncated: the Spill file holding the full text. */
	fullOutputPath?: string;
	/** Truncation notice, including a failed attempt to save the full output. */
	outputWarning?: string;
	/** Raw-text limits shared by model output and the TUI renderer. */
	outputLimits?: TruncationOptions;
	/** Set on partial updates while the Cell runs; its streams are tails cut to `outputLimits`. */
	running?: true;
	/** Dispatch timestamp used by the TUI timer; only present on partial updates. */
	startedAt?: number;
	/** True when this result carries the State-loss notice. */
	stateLost?: boolean;
	stateLossCause?: string;
	stateLossCellRan?: boolean;
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
	/** Text appended to the model-facing description (the `pi` API and Listed Pi tools), or undefined to leave it unchanged. */
	describePiTools?: (loadout: ToolLoadout) => string | undefined;
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
		stateLossCause: cause,
		stateLossCellRan: cellRan,
	};
	return { content: [{ type: "text" as const, text }], details, isError: true };
}

/** A piece of the model-facing text: literal text, or a stream without its trailing newline. */
type Segment = string | OutputBuffer;

const BACKGROUND_HEADING = "[background output]";

/**
 * Model-facing text as segments: stdout, then stderr (labelled), then the trailing expression's repr,
 * then the traceback, then Background output (labelled), one per line.
 */
function cellSegments(r: CellResult): { segments: Segment[]; backgroundSegment?: number } {
	const o = r.output ?? textOutput(r);
	const parts: Segment[][] = [];
	if (o.stdout.totalBytes) parts.push([o.stdout]);
	if (o.stderr.totalBytes) parts.push(["[stderr]\n", o.stderr]);
	if (r.result !== undefined) parts.push([r.result]);
	if (r.error) {
		const traceback = r.error.traceback.join("").replace(/\n$/, "");
		parts.push([traceback || `${r.error.ename}: ${r.error.evalue}`]);
	}
	if (r.status === "aborted") parts.push(["[Cell aborted]"]);
	const hasBackground = o.background.totalBytes > 0;
	if (hasBackground) parts.push([`${BACKGROUND_HEADING}\n`, o.background]);
	const segments = parts.flatMap((part, i) => (i === 0 ? part : ["\n", ...part]));
	return { segments, backgroundSegment: hasBackground ? segments.length - 2 : undefined };
}

/** A result's streams from its text alone, for results without `output`. */
function textOutput(r: CellResult): CellOutput {
	const buffer = (text: string) => {
		const b = new OutputBuffer(Infinity, Infinity);
		b.append(text);
		return b;
	};
	return { stdout: buffer(r.stdout), stderr: buffer(r.stderr), background: buffer(r.backgroundOutput) };
}

/**
 * The model-facing text, its tail kept within the limits (tracebacks and results come last), with the
 * full text written to a Spill file when cut. Reads stream tails and spools, never whole streams.
 * `live` is for a running Cell: the notice counts output so far, and no Spill file is written.
 */
export function composeCellText(
	r: CellResult,
	limits: TruncationOptions,
	{ live = false } = {},
): { text: string; fullOutputPath?: string; outputWarning?: string } {
	const { segments, backgroundSegment } = cellSegments(r);
	let tail = "";
	let totalBytes = 0;
	let newlines = 0;
	let backgroundStart = -1;
	for (const [i, segment] of segments.entries()) {
		if (i === backgroundSegment) backgroundStart = tail.length;
		if (typeof segment === "string") {
			tail += segment;
			totalBytes += Buffer.byteLength(segment);
			newlines += countNewlines(segment);
		} else {
			const drop = segment.endsWithNewline ? 1 : 0;
			tail += drop ? segment.tail.slice(0, -1) : segment.tail;
			totalBytes += segment.totalBytes - drop;
			newlines += segment.newlines - drop;
		}
	}
	if (totalBytes === 0) {
		tail = "(no output)";
		totalBytes = tail.length;
		segments.splice(0, segments.length, tail);
	}
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
	const totalLines = newlines + (tail.endsWith("\n") ? 0 : 1);
	if (totalLines <= maxLines && totalBytes <= maxBytes) return { text: tail };

	// Each stream's tail is long enough that cutting the joined tails equals cutting the full text.
	const t = truncateTail(tail, { maxBytes, maxLines });
	let content = t.content;
	let shown = t.lastLinePartial
		? `the last ${formatSize(t.outputBytes)} of the last line`
		: `the last ${t.outputLines} of ${totalLines} lines`;
	if (backgroundStart >= 0 && tail.length - content.length > backgroundStart) {
		// Restore the attribution unless it can only fit in the live notice.
		const headingBytes = Buffer.byteLength(BACKGROUND_HEADING);
		const showHeading = !live || headingBytes <= maxBytes;
		const background = truncateTail(tail.slice(backgroundStart + BACKGROUND_HEADING.length + 1), {
			maxLines: showHeading ? Math.max(0, maxLines - 1) : maxLines,
			maxBytes: showHeading ? Math.max(0, maxBytes - headingBytes - 1) : maxBytes,
		});
		content = showHeading
			? [BACKGROUND_HEADING, background.content].filter(Boolean).join("\n")
			: background.content;
		shown = `the tail of background output (${formatSize(background.outputBytes)})`;
	}
	if (live) {
		const outputWarning = `[Output truncated (${formatSize(totalBytes)} so far): showing ${shown}]`;
		return { text: content ? `${content}\n\n${outputWarning}` : outputWarning, outputWarning };
	}
	const fullOutputPath = join(tmpdir(), `pi-ipython-${randomUUID()}.log`);
	try {
		writeSpillFile(fullOutputPath, segments);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const outputWarning = `[Output truncated (${formatSize(totalBytes)} total): showing ${shown}. Full output could not be saved: ${reason}]`;
		return { text: `${content}\n\n${outputWarning}`, outputWarning };
	}
	const outputWarning = `[Output truncated (${formatSize(totalBytes)} total): showing ${shown}. Full output: ${fullOutputPath}]`;
	return { text: `${content}\n\n${outputWarning}`, fullOutputPath, outputWarning };
}

// The same throttle as pi's bash tool (BASH_UPDATE_THROTTLE_MS, not exported).
const LIVE_UPDATE_INTERVAL_MS = 100;

/** A running Cell's streams (none yet when undefined) as a partial update: tails cut to the limits, no Spill file. */
function liveResult(output: CellOutput | undefined, limits: TruncationOptions, startedAt: number) {
	const cut = (b: OutputBuffer | undefined) => (b ? truncateTail(b.tail, limits).content : "");
	const details: IpythonToolDetails = {
		stdout: cut(output?.stdout),
		stderr: cut(output?.stderr),
		backgroundOutput: cut(output?.background),
		images: [],
		status: "ok",
		durationMs: Date.now() - startedAt,
		outputLimits: limits,
		running: true,
		startedAt,
	};
	if (!output || output.stdout.totalBytes + output.stderr.totalBytes + output.background.totalBytes === 0) {
		return { content: [], details };
	}
	const partialCell: CellResult = { ...details, output };
	return { content: [{ type: "text" as const, text: composeCellText(partialCell, limits, { live: true }).text }], details };
}

/**
 * Throttled partial updates for one Cell: the first at once, then at most one per interval while its
 * output grows. None after `close`, so none outlives the tool call.
 */
function liveUpdates(onUpdate: AgentToolUpdateCallback<IpythonToolDetails>, limits: TruncationOptions) {
	let startedAt: number | undefined;
	let output: CellOutput | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastAt = 0;
	let closed = false;
	const emit = () => {
		timer = undefined;
		if (closed || startedAt === undefined) return;
		lastAt = Date.now();
		try {
			onUpdate(liveResult(output, limits, startedAt));
		} catch {} // Progress must never fail the Cell.
	};
	return {
		/** Like pi's bash tool: an update with no output marks the start. */
		start(dispatchedAt: number) {
			startedAt = dispatchedAt;
			emit();
		},
		notify(current: CellOutput) {
			if (closed) return;
			output = current;
			const wait = LIVE_UPDATE_INTERVAL_MS - (Date.now() - lastAt);
			if (wait <= 0) {
				clearTimeout(timer);
				emit();
			} else {
				timer ??= setTimeout(emit, wait);
			}
		},
		close() {
			closed = true;
			clearTimeout(timer);
			output = undefined;
		},
	};
}

/** Write the segments to a new Spill file; a partial file is removed. */
function writeSpillFile(path: string, segments: Segment[]): void {
	// `wx` never follows a link someone else placed at the path.
	const fd = openSync(path, "wx", 0o600);
	try {
		for (const segment of segments) {
			if (typeof segment === "string") writeAll(fd, Buffer.from(segment, "utf8"));
			else segment.writeTo(fd, true);
		}
	} catch (error) {
		try { closeSync(fd); } catch {}
		try { rmSync(path, { force: true }); } catch {}
		throw error;
	}
	try {
		closeSync(fd);
	} catch (error) {
		try { rmSync(path, { force: true }); } catch {}
		throw error;
	}
}

export function createIpythonTool({
	getKernel,
	killKernel,
	getOutputLimits = () => ({}),
	getConfirmEachCell = () => false,
	takeStateLoss = () => undefined,
	answerHostRequest,
	describePiTools,
}: IpythonToolOptions): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const description =
		"Run Python code in a persistent Python Kernel. Variables, functions, and imports persist between calls. Top-level `await` works. The output contains stdout, stderr, the repr of the trailing expression, and errors with tracebacks. Long output is truncated to its tail, with the full text saved to a Spill file. Images emitted with `from rlm.repl import emit; emit({'image/png': base64_str})` are returned as images. Output from background threads, tasks, and subprocesses is reported under [background output] in the next result.";
	return {
		name: IPYTHON_TOOL_NAME,
		label: "ipython",
		description,
		promptSnippet: "ipython - persistent Python Kernel for code, data, and state",
		parameters: ipythonSchema,
		// One Kernel runs one Cell at a time.
		executionMode: "sequential",
		// Cells can discover/call any Pi tool: let MCP finish registration before Python runs.
		reachesTools: () => "all",
		// Other active tools are there only for Bridged calls: the model sees only ipython.
		prepareLoadout: (loadout) => {
			const piGuidance = describePiTools?.(loadout);
			return {
				...(piGuidance === undefined ? {} : { descriptions: { [IPYTHON_TOOL_NAME]: `${description}\n\n${piGuidance}` } }),
				hiddenDeclarations: loadout.declared.map((tool) => tool.name).filter((name) => name !== IPYTHON_TOOL_NAME),
			};
		},
		renderCall: renderCellCall,
		renderResult: renderCellResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Never run a Cell written against Python state that is already gone (ADR 0003).
			const lostCause = takeStateLoss();
			if (lostCause !== undefined) return stateLostResult(lostCause);
			if (getConfirmEachCell()) {
				if (!ctx.hasUI) throw new Error(CONFIRM_NO_UI_ERROR);
				if (!(await ctx.ui.confirm("Run this Python Cell?", params.code, { signal }))) throw new Error(CELL_REJECTED_ERROR);
			}
			let r: CellResult;
			const live = onUpdate && liveUpdates(onUpdate, getOutputLimits());
			try {
				for (;;) {
					// A dialog may have outlived the Kernel whose state this Cell assumes.
					const cause = takeStateLoss();
					if (cause !== undefined) return stateLostResult(cause);
					try {
						r = await getKernel().execute(params.code, {
							signal,
							onHostRequest: answerHostRequest && ((data) => answerHostRequest(data, ctx, signal)),
							onDispatch: live?.start,
							onOutput: live?.notify,
						});
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
			} finally {
				live?.close();
			}
			const outputLimits = getOutputLimits();
			let composed: ReturnType<typeof composeCellText>;
			try {
				composed = composeCellText(r, outputLimits);
			} finally {
				disposeCellOutput(r.output);
			}
			const { output: _output, ...result } = r;
			// Image notices stay visible whatever the output limits cut.
			const text = r.imageNotice ? `${composed.text}\n\n${r.imageNotice}` : composed.text;
			const images: ImageContent[] = r.images.map((i) => ({ type: "image", ...i }));
			const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
			return {
				content,
				details: { ...result, fullOutputPath: composed.fullOutputPath, outputWarning: composed.outputWarning, outputLimits },
				isError: r.status !== "ok",
			};
		},
	};
}
