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
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CellModelCalls, type ModelCallsSummary, PI_ASK_REQUEST, PI_CLASSIFY_REQUEST } from "../bridge/model-calls.ts";
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
			"`re.search(r'\\.', text)` or `await bash(r\"rg 'LetterBox\\(' .\")`. Use `rf'...'` when interpolating, or double backslashes in a non-raw string. In f-strings, double literal braces: `{{ }}`.",
	}),
});

export interface IpythonToolDetails extends Omit<CellResult, "output"> {
	/** Set when the text was truncated: the Spill file holding the full text. */
	fullOutputPath?: string;
	/** Warning for the TUI when the full output could not be saved. */
	outputWarning?: string;
	/** Raw-text limits shared by model output and the TUI renderer. */
	outputLimits?: TruncationOptions;
	/** Set on partial updates while the Cell runs; its streams are tails cut to `outputLimits`. */
	running?: true;
	/** Dispatch timestamp used by the TUI timer; only present on partial updates. */
	startedAt?: number;
	/** The Cell's Model calls so far; absent when it made none. */
	modelCalls?: ModelCallsSummary;
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
	/**
	 * Starts one Cell's Model calls, which answer its `pi.ask` requests and sum their usage into the result.
	 * `onChange` is called whenever their summary changes.
	 */
	startModelCalls?: (ctx: ExtensionToolContext, signal: AbortSignal | undefined, onChange: () => void) => CellModelCalls;
	/** The `pi.ask` paragraph of the description, or undefined while Model calls are off. */
	describeModelCalls?: () => string | undefined;
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

/** Share of a cut section's limits kept for its start; its end gets the rest. */
const HEAD_SHARE = 0.2;

/**
 * Model-facing text in two sections: the Cell's own (stdout, then stderr labelled, then the trailing
 * expression's repr, then the traceback, one per line), and Background output, shown under its heading.
 */
function cellSections(r: CellResult): { own: Segment[]; background?: OutputBuffer } {
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
	const background = o.background.totalBytes > 0 ? o.background : undefined;
	if (!parts.length && !background) parts.push(["(no output)"]);
	return { own: parts.flatMap((part, i) => (i === 0 ? part : ["\n", ...part])), background };
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

/** A section's text, read from stream starts and tails, never whole streams. */
interface Section {
	/** Its start: the whole text unless a stream dropped its middle. */
	head: string;
	/** Its end: the whole text unless a stream dropped its start. Each stream tail outlasts the limits. */
	tail: string;
	bytes: number;
	lines: number;
}

function measure(segments: Segment[]): Section {
	let head = "";
	let headDone = false;
	let tail = "";
	let bytes = 0;
	let newlines = 0;
	for (const segment of segments) {
		if (typeof segment === "string") {
			tail += segment;
			if (!headDone) head += segment;
			bytes += Buffer.byteLength(segment);
			newlines += countNewlines(segment);
			continue;
		}
		const drop = segment.endsWithNewline ? 1 : 0;
		const text = drop ? segment.tail.slice(0, -1) : segment.tail;
		tail += text;
		if (!headDone) {
			headDone = segment.truncated;
			head += headDone ? segment.head : text;
		}
		bytes += segment.totalBytes - drop;
		newlines += segment.newlines - drop;
	}
	return { head, tail, bytes, lines: newlines + (tail.endsWith("\n") ? 0 : 1) };
}

/**
 * A section within the limits: whole, or its start and end around a marker saying what was elided.
 * The end gets most of the limits, as it holds the traceback or summary.
 */
function cutMiddle(s: Section, maxLines: number, maxBytes: number, markerSuffix: string): string {
	if (s.lines <= maxLines && s.bytes <= maxBytes) return s.tail;
	const headMaxBytes = Math.floor(maxBytes * HEAD_SHARE);
	const headMaxLines = headMaxBytes > 0 ? Math.floor(maxLines * HEAD_SHARE) : 0;
	const head = truncateHead(s.head, { maxLines: headMaxLines, maxBytes: headMaxBytes });
	const prefix = head.firstLineExceedsLimit && headMaxLines > 0 ? utf8Prefix(s.head, headMaxBytes) : "";
	const headLines = prefix ? 1 : head.outputLines;
	const headBytes = prefix ? Buffer.byteLength(prefix) : head.outputBytes + (headLines > 0 ? 1 : 0);
	// A partial head needs a display newline, but that newline wasn't in the source.
	const tail = truncateTail(s.tail, { maxLines: maxLines - headLines, maxBytes: maxBytes - headBytes - (prefix ? 1 : 0) });
	const elided = prefix || tail.lastLinePartial
		? formatSize(s.bytes - headBytes - tail.outputBytes)
		: plural(s.lines - headLines - tail.outputLines, "line");
	const parts = [`[… ${elided} elided${markerSuffix}]`];
	if (headLines > 0) parts.unshift(prefix || head.content);
	if (tail.content || (tail.outputLines > 0 && !tail.lastLinePartial)) parts.push(tail.content);
	return parts.join("\n");
}

function utf8Prefix(text: string, maxBytes: number): string {
	let end = 0;
	for (const char of text) {
		maxBytes -= Buffer.byteLength(char);
		if (maxBytes < 0) break;
		end += char.length;
	}
	return text.slice(0, end);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Give a small section what it needs; share spare capacity if this limit isn't binding. */
function share(limit: number, need: number, other: number): number {
	if (!other) return limit;
	if (!need) return 0;
	const half = Math.floor(limit / 2);
	if (need + other <= limit) return Math.min(limit - other, Math.max(need, half));
	if (need <= half) return need;
	if (other <= half) return limit - other;
	return half;
}

/**
 * The model-facing text within the limits. When cut, each section keeps its start and its end
 * around an elision marker, so the Cell's traceback stays visible however much Background output
 * follows it, and the full text is written to a Spill file. The Background output heading and the
 * markers are labels outside the limits.
 * `live` is for a running Cell: the markers count output so far, and no Spill file is written.
 */
export function composeCellText(
	r: CellResult,
	limits: TruncationOptions,
	{ live = false } = {},
): { text: string; fullOutputPath?: string; outputWarning?: string } {
	const { own, background } = cellSections(r);
	const ownSection = own.length ? measure(own) : undefined;
	const backgroundSection = background && measure([background]);
	const joinSections = (ownText: string | undefined, backgroundText: string | undefined) =>
		[ownText, backgroundText === undefined ? undefined : `${BACKGROUND_HEADING}\n${backgroundText}`]
			.filter((text) => text !== undefined)
			.join("\n");
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
	// The newline between the sections counts toward the limits.
	const sectionBytes = Math.max(0, maxBytes - (ownSection && backgroundSection ? 1 : 0));
	const ownLines = ownSection?.lines ?? 0;
	const ownBytes = ownSection?.bytes ?? 0;
	const backgroundLines = backgroundSection?.lines ?? 0;
	const backgroundBytes = backgroundSection?.bytes ?? 0;
	if (ownLines + backgroundLines <= maxLines && ownBytes + backgroundBytes <= sectionBytes) {
		return { text: joinSections(ownSection?.tail, backgroundSection?.tail) };
	}

	let markerSuffix = "";
	let fullOutputPath: string | undefined;
	let outputWarning: string | undefined;
	if (!live) {
		const path = join(tmpdir(), `pi-ipython-${randomUUID()}.log`);
		const spill: Segment[] = background ? [...own, ...(own.length ? ["\n"] : []), `${BACKGROUND_HEADING}\n`, background] : own;
		try {
			writeSpillFile(path, spill);
			fullOutputPath = path;
			markerSuffix = `, full output in ${path}`;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			markerSuffix = `, full output could not be saved: ${reason}`;
			outputWarning = `[Output truncated; full output could not be saved: ${reason}]`;
		}
	}
	// If there isn't room to split the budget, give it to the traceback, not Background output.
	const prioritizeError = r.error && background && (maxLines === 1 || sectionBytes <= 1);
	const cutBytes = prioritizeError ? maxBytes : sectionBytes;
	const ownMaxLines = prioritizeError ? maxLines : share(maxLines, ownLines, backgroundLines);
	const ownMaxBytes = prioritizeError ? cutBytes : share(cutBytes, ownBytes, backgroundBytes);
	const ownCut = ownSection && cutMiddle(ownSection, ownMaxLines, ownMaxBytes, markerSuffix);
	const backgroundCut = backgroundSection && cutMiddle(backgroundSection, maxLines - ownMaxLines, cutBytes - ownMaxBytes, markerSuffix);
	return { text: joinSections(ownCut, backgroundCut), fullOutputPath, outputWarning };
}

// The same throttle as pi's bash tool (BASH_UPDATE_THROTTLE_MS, not exported).
const LIVE_UPDATE_INTERVAL_MS = 100;

/** A running Cell's streams (none yet when undefined) as a partial update: tails cut to the limits, no Spill file. */
function liveResult(
	output: CellOutput | undefined,
	limits: TruncationOptions,
	startedAt: number,
	modelCalls: ModelCallsSummary | undefined,
) {
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
		...(modelCalls ? { modelCalls } : {}),
	};
	if (!output || output.stdout.totalBytes + output.stderr.totalBytes + output.background.totalBytes === 0) {
		return { content: [], details };
	}
	const partialCell: CellResult = { ...details, output };
	return { content: [{ type: "text" as const, text: composeCellText(partialCell, limits, { live: true }).text }], details };
}

/**
 * Throttled partial updates for one Cell: the first at once, then at most one per interval while its
 * output or Model calls grow. None after `close`, so none outlives the tool call.
 */
function liveUpdates(
	onUpdate: AgentToolUpdateCallback<IpythonToolDetails>,
	limits: TruncationOptions,
	getModelCalls: () => ModelCallsSummary | undefined,
) {
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
			onUpdate(liveResult(output, limits, startedAt, getModelCalls()));
		} catch {} // Progress must never fail the Cell.
	};
	const changed = () => {
		if (closed) return;
		const wait = LIVE_UPDATE_INTERVAL_MS - (Date.now() - lastAt);
		if (wait <= 0) {
			clearTimeout(timer);
			emit();
		} else {
			timer ??= setTimeout(emit, wait);
		}
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
			changed();
		},
		/** The Model-call summary changed. */
		modelCallsChanged: changed,
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
	startModelCalls,
	describeModelCalls,
}: IpythonToolOptions): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const description =
		"Run Python code in a persistent Python Kernel. The output contains stdout, stderr, the repr of the trailing expression, and errors with tracebacks. Long output keeps its start and end, with the full text saved to a Spill file. Images emitted with `from rlm.repl import emit; emit({'image/png': base64_str})` are returned as images. Output from background threads, tasks, and subprocesses is reported under [background output] in the next result.";
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
			// The Model-call paragraph does not depend on callable Pi tools.
			const guidance = [describeModelCalls?.(), describePiTools?.(loadout)].filter((text) => text !== undefined);
			return {
				...(guidance.length === 0 ? {} : { descriptions: { [IPYTHON_TOOL_NAME]: [description, ...guidance].join("\n\n") } }),
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
			const live = onUpdate && liveUpdates(onUpdate, getOutputLimits(), () => modelCalls?.summary());
			const modelCalls = startModelCalls?.(ctx, signal, () => live?.modelCallsChanged());
			// Model calls gathered so far stay on every result of a Cell that ran, even an aborted one.
			const withModelCalls = <T extends { details: IpythonToolDetails }>(result: T) => {
				const summary = modelCalls?.summary();
				if (!summary) return result;
				return { ...result, details: { ...result.details, modelCalls: summary }, ...(modelCalls!.usage ? { usage: modelCalls!.usage } : {}) };
			};
			const onHostRequest = modelCalls || answerHostRequest
				? (data: Record<string, unknown>) => {
					if (modelCalls && data.type === PI_ASK_REQUEST) return modelCalls.ask(data);
					if (modelCalls && data.type === PI_CLASSIFY_REQUEST) return modelCalls.classify(data);
					if (!answerHostRequest) throw new Error(`host request ${String(data.type)} is not supported by pi-ipython`);
					return answerHostRequest(data, ctx, signal);
				}
				: undefined;
			try {
				for (;;) {
					// A dialog may have outlived the Kernel whose state this Cell assumes.
					const cause = takeStateLoss();
					if (cause !== undefined) return stateLostResult(cause);
					try {
						r = await getKernel().execute(params.code, {
							signal,
							onHostRequest,
							onDispatch: live?.start,
							onOutput: live?.notify,
						});
						break;
					} catch (error) {
						if (!(error instanceof KernelBusyError) || signal?.aborted) {
							// This Cell's Kernel died under it: its own error tells the model. Never replay it.
							const cause = takeStateLoss();
							if (cause !== undefined) return withModelCalls(stateLostResult(cause, true));
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
				// A Model call never outlives its Cell's tool call.
				modelCalls?.close();
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
			return withModelCalls({
				content,
				details: { ...result, fullOutputPath: composed.fullOutputPath, outputWarning: composed.outputWarning, outputLimits },
				isError: r.status !== "ok",
			});
		},
	};
}
