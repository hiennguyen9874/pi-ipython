// Kernel client: the Kernel is a JSON-lines subprocess (`python -m rlm.repl`) with requests on
// stdin and events on stdout. The protocol (REPL protocol v3) is runtime/src/rlm/repl.md.
//
// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa,
// packages/coding-agent/src/core/kernel/repl-manager.ts), adapted to pi's extension API.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { type CellImage, ImageCollector } from "./images.ts";
import { ORPHAN_JOURNAL_ENV, reapKernel, recordProcess } from "./orphans.ts";
import { OutputBuffer } from "./output-buffer.ts";

export type { CellImage } from "./images.ts";

export const REPL_PROTOCOL_VERSION = 3;
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
// After an abort, how long the interrupted Cell gets to finish before its tool call returns anyway.
const ABORT_GRACE_MS = 1_000;
// How long the next Cell waits for an interrupted Cell to finish, re-sending interrupts, before it is busy.
const BUSY_WAIT_MS = 5_000;
const BUSY_INTERRUPT_INTERVAL_MS = 500;
const MAX_STDERR_TAIL_CHARS = 8 * 1024;
// A line that cannot complete within this ceiling is corruption, not output worth buffering until OOM.
const MAX_PROTOCOL_LINE_CHARS = 32 * 1024 * 1024;
// The exact event vocabulary of protocol v3: an unknown kind is corruption, not a newer runtime.
const PROTOCOL_EVENT_KINDS = new Set(["ready", "stdout", "stderr", "result", "display", "host_request", "error", "done"]);
/** Image MIME types models accept; other display payloads are ignored. */
export const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The Kernel is still running an interrupted Cell that ignored repeated interrupts. */
export class KernelBusyError extends Error {
	constructor() {
		super("Kernel busy: the previously interrupted Cell is still running and did not stop after repeated interrupts.");
		this.name = "KernelBusyError";
	}
}

/** A failed host request whose reply also carries `result`, such as a failed tool call's structured content. */
export class HostRequestError extends Error {
	constructor(message: string, readonly result: unknown) {
		super(message);
		this.name = "HostRequestError";
	}
}

export interface CellError {
	ename: string;
	evalue: string;
	traceback: string[];
}

/** The full text of each stream of a Cell's result. Whoever holds it disposes it. */
export interface CellOutput {
	stdout: OutputBuffer;
	stderr: OutputBuffer;
	background: OutputBuffer;
}

export function disposeCellOutput(output: CellOutput | undefined): void {
	output?.stdout.dispose();
	output?.stderr.dispose();
	output?.background.dispose();
}

export interface CellResult {
	/** The tail of stdout (see OutputBuffer), the whole text when short. */
	stdout: string;
	stderr: string;
	/** The last images emitted by this Cell or buffered from background displays, fitted to send. */
	images: CellImage[];
	/** Why images were dropped, if any were. */
	imageNotice?: string;
	/** The tail of Background output (stdout/stderr with no owning Cell) since the last Cell. */
	backgroundOutput: string;
	/** The full text of each stream, absent from results no Kernel produced. Dispose it after use. */
	output?: CellOutput;
	/** repr of the trailing expression, when it is not None. */
	result?: string;
	error?: CellError;
	/** Live names, from a `list_names` request (not a Cell). */
	names?: string[];
	status: "ok" | "error" | "aborted";
	durationMs: number;
}

export interface KernelClientOptions {
	cwd: string;
	/** Resolves the Python that has the Kernel runtime installed (may build the venv). */
	resolvePython: () => Promise<string>;
	/** Code run once right after the Kernel starts, before any Cell. */
	bootstrapCode?: string;
	/** stderr of a bootstrap that succeeded, such as prelude imports that failed. */
	onBootstrapStderr?: (stderr: string) => void;
	/** Extra environment for the Kernel process. */
	env?: Record<string, string>;
	/** This host's orphan journal (see orphans.ts), so a Kernel left by a crashed host is reaped later. */
	journalPath?: string;
	/** A ready Kernel process died or broke the protocol (not a shutdown, not a failed start). */
	onLost?: (error: Error) => void;
	/** Handlers for host request types the runtime sends on its own (keyed by `type`), answered whether or not a Cell runs. */
	hostHandlers?: Readonly<Record<string, HostRequestHandler>>;
	/** The output limits: memory kept per stream is derived from them. */
	getOutputLimits?: () => { maxBytes?: number; maxLines?: number };
}

/** Answers one `host_request`: resolves with the reply's result, rejects with its error. */
export type HostRequestHandler = (data: Record<string, unknown>) => Promise<unknown>;

/** Told that a running Cell's output grew, with its streams so far. Read them before the Cell's result is used. */
export type CellOutputListener = (output: CellOutput) => void;

/** Requests that run in order and end with a `done` frame. */
type KernelRequest = { type: "execute"; code: string } | { type: "list_names" };

interface ActiveCell {
	id: string;
	requestType: KernelRequest["type"];
	started: number;
	signal?: AbortSignal;
	onHostRequest?: HostRequestHandler;
	onOutput?: CellOutputListener;
	stdout: OutputBuffer;
	stderr: OutputBuffer;
	result?: string;
	error?: CellError;
	names?: string[];
	/** Its tool call already returned (aborted); the Cell stays active until its `done`. */
	settled: boolean;
	/** Resolves when the Cell is no longer active. */
	finished: Promise<void>;
	markFinished: () => void;
	resolve: (result: CellResult | Promise<CellResult>) => void;
	reject: (error: Error) => void;
}

/** One Kernel process, started lazily on the first Cell and restartable after it dies or is shut down. */
export class KernelClient {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private active?: ActiveCell;
	private ready?: { resolve: (protocol: number) => void; reject: (error: Error) => void };
	/** Serializes requests: the runtime runs one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	private stderrTail = "";
	private background: OutputBuffer;
	private readonly images = new ImageCollector();
	/** Bumped by every shutdown so a stale in-flight start never keeps its process. */
	private generation = 0;
	/** The process that finished starting; losing any other one is a failed start. */
	private readyChild?: ChildProcess;

	constructor(private readonly options: KernelClientOptions) {
		this.background = this.newBuffer();
	}

	/** True while a Kernel process exists (starting or running). */
	get isRunning(): boolean {
		return this.child !== undefined;
	}

	get isBusy(): boolean {
		return this.active !== undefined;
	}

	/** Start the Kernel if it is not running. Concurrent callers share one start. */
	start(): Promise<void> {
		if (!this.starting) {
			const starting = this.boot().catch((error: unknown) => {
				if (this.starting === starting) this.starting = undefined;
				throw error;
			});
			this.starting = starting;
		}
		return this.starting;
	}

	/**
	 * Run one Cell, starting the Kernel first if needed. `onHostRequest` answers its host requests while it runs;
	 * `onOutput` hears of its output (its own and Background output) until its tool call returns.
	 */
	async execute(code: string, signal?: AbortSignal, onHostRequest?: HostRequestHandler, onOutput?: CellOutputListener): Promise<CellResult> {
		await this.start();
		return this.request({ type: "execute", code }, signal, onHostRequest, onOutput);
	}

	/**
	 * Live user-defined top-level names, or null when no Kernel is running, it is still busy with
	 * an interrupted Cell, or the listing fails. Never starts a Kernel or interrupts a Cell.
	 */
	async listNames(signal?: AbortSignal): Promise<string[] | null> {
		if (!this.child || this.active) return null;
		try {
			await this.starting;
			const result = await this.request({ type: "list_names" }, signal);
			disposeCellOutput(result.output);
			return result.status === "ok" ? (result.names ?? []) : null;
		} catch {
			return null;
		}
	}

	/** Raise KeyboardInterrupt in the running Cell. */
	interrupt(): void {
		// Always target the Cell: an id-less interrupt with nothing running is parked for the next request.
		const id = this.active?.id;
		if (id) this.write({ type: "interrupt", id }).catch(() => undefined);
	}

	/** Stop the Kernel: graceful shutdown request, then SIGKILL after a grace period. */
	async shutdown(): Promise<void> {
		this.generation++;
		const child = this.child;
		this.child = undefined;
		this.readyChild = undefined;
		this.starting = undefined;
		this.failPending(new Error("Kernel was shut down"));
		this.resetBackground();
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		const timer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
		child.stdin?.end(`${JSON.stringify({ type: "shutdown" })}\n`);
		await exited;
		clearTimeout(timer);
	}

	private async boot(): Promise<void> {
		const generation = this.generation;
		const python = await this.options.resolvePython();
		if (generation !== this.generation) throw new Error("Kernel was shut down during startup");

		this.stderrTail = "";
		this.resetBackground();
		const args = process.platform === "win32"
			? [fileURLToPath(new URL("./windows-kernel.py", import.meta.url))]
			: ["-m", "rlm.repl"];
		const child = spawn(python, args, {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...this.options.env,
				...(process.platform === "win32" ? { PYTHONUTF8: "1" } : {}),
				// The runtime exits when this pid dies, so a crashed pi leaves no Kernel behind.
				UNHARNESSED_KERNEL_OWNER_PID: String(process.pid),
				...(this.options.journalPath ? { [ORPHAN_JOURNAL_ENV]: this.options.journalPath } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group, so the Kernel's child processes can be killed with it.
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.child = child;
		const { journalPath } = this.options;
		const pid = child.pid;
		if (pid !== undefined) {
			if (journalPath) recordProcess(journalPath, pid, true);
			child.once("exit", () => reapKernel(journalPath, pid));
		}
		const ready = new Promise<number>((resolve, reject) => {
			this.ready = { resolve, reject };
		});
		this.wire(child);

		try {
			const protocol = await withTimeout(ready, READY_TIMEOUT_MS, () =>
				this.withStderr(`Kernel did not become ready within ${READY_TIMEOUT_MS}ms`),
			);
			if (protocol !== REPL_PROTOCOL_VERSION) {
				throw new Error(`Kernel runtime speaks protocol ${protocol}, expected ${REPL_PROTOCOL_VERSION}`);
			}
			if (this.options.bootstrapCode) {
				const result = await this.request({ type: "execute", code: this.options.bootstrapCode });
				disposeCellOutput(result.output);
				if (result.status !== "ok") {
					const details = [result.stderr, result.error?.traceback.join("")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize the Kernel runtime:\n${details}`);
				}
				if (result.stderr) this.options.onBootstrapStderr?.(result.stderr);
			}
		} catch (error) {
			if (this.child === child) await this.shutdown();
			throw error;
		}
		if (generation !== this.generation) throw new Error("Kernel was shut down during startup");
		this.readyChild = child;
	}

	private wire(child: ChildProcess): void {
		const decoder = new StringDecoder("utf8");
		let pending = "";
		child.stdout?.on("data", (buf: Buffer) => {
			if (this.child !== child) return;
			pending += decoder.write(buf);
			let newline = pending.indexOf("\n");
			while (newline !== -1 && this.child === child) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
				if (line.trim()) this.handleLine(child, line);
			}
			if (pending.length > MAX_PROTOCOL_LINE_CHARS) {
				this.lose(child, new Error(`Kernel protocol error: line exceeds ${MAX_PROTOCOL_LINE_CHARS} chars`));
			}
		});

		// The runtime moves fd 2 into its protocol pump before ready, so this only carries startup output.
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (text: string) => {
			this.stderrTail = (this.stderrTail + text).slice(-MAX_STDERR_TAIL_CHARS);
		});
		// Stream errors are separate from child-process errors, even with a write callback.
		for (const stream of [child.stdin, child.stdout, child.stderr]) {
			stream?.on("error", (error) => this.lose(child, error));
		}
		child.on("error", (error) => this.lose(child, error));
		// "close" fires after stdio drained, so the stderr tail is complete.
		child.on("close", (code, signal) => {
			this.lose(child, this.withStderr(`Kernel exited (${signal ?? `exit code ${code}`})`));
		});
	}

	private handleLine(child: ChildProcess, line: string): void {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return this.lose(child, new Error(`Kernel protocol error: unparseable line: ${line.slice(0, 200)}`));
		}
		const reason = invalidFrameReason(event);
		if (reason) return this.lose(child, new Error(`Kernel protocol error: ${reason}: ${line.slice(0, 200)}`));
		this.handleEvent(event as Record<string, unknown>);
	}

	private handleEvent(event: Record<string, unknown>): void {
		const type = event.event;
		if (type === "ready") {
			this.ready?.resolve(typeof event.protocol === "number" ? event.protocol : -1);
			return;
		}
		if (type === "host_request") {
			this.answerHostRequest(event.id as string, event.data);
			return;
		}
		const cell = this.active;
		if (cell?.settled && event.id === cell.id && type === "done") {
			// An interrupted Cell whose tool call already returned has finished: the Kernel is free.
			this.clearActive();
			return;
		}
		if (!cell || event.id !== cell.id || cell.settled) {
			// Output without this Cell's id (threads, subprocesses, other Cells) is not credited to it:
			// it is buffered and reported as background output with the next finished Cell.
			if (type === "stdout" || type === "stderr") {
				this.background.append(asString(event.text));
				// It is reported with the running Cell.
				if (cell && !cell.settled && cell.requestType === "execute") this.notifyOutput(cell);
			} else if (type === "display") for (const image of imagesFromDisplay(event.data)) this.images.push(image);
			return;
		}
		if (type === "stdout" || type === "stderr") {
			cell[type].append(asString(event.text));
			this.notifyOutput(cell);
		} else if (type === "result") cell.result = asString(event.text);
		else if (type === "display" && cell.requestType === "execute") {
			for (const image of imagesFromDisplay(event.data)) this.images.push(image);
		} else if (type === "error") {
			cell.error = {
				ename: asString(event.ename) || "Error",
				evalue: asString(event.evalue),
				traceback: Array.isArray(event.traceback) ? event.traceback.filter((t) => typeof t === "string") : [],
			};
		} else if (type === "done") {
			if (Array.isArray(event.names)) cell.names = event.names.filter((n) => typeof n === "string");
			this.clearActive();
			this.settle(cell, event.status === "ok" && !cell.error ? "ok" : "error");
		}
	}

	/**
	 * Route a host request to its handler and reply. Every request gets a reply, so the awaiting Python
	 * fails instead of hanging. Types in `hostHandlers` are answered at any time. The rest arrive without
	 * a Cell id, so they go to the Cell running now, and none is answered while no Cell's tool call is running.
	 */
	private answerHostRequest(id: string, data: unknown): void {
		const child = this.child;
		const cell = this.active;
		const cellHandler = cell && !cell.settled ? cell.onHostRequest : undefined;
		const reply = (data: Record<string, unknown>) => {
			// A reply must never reach a replacement Kernel.
			if (this.child === child) this.write({ type: "host_reply", id, data }).catch(() => undefined);
		};
		const answer = async () => {
			if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("host request data must be an object");
			const request = data as Record<string, unknown>;
			const hostHandlers = this.options.hostHandlers ?? {};
			const type = request.type;
			const handler = typeof type === "string" && Object.hasOwn(hostHandlers, type) ? hostHandlers[type] : cellHandler;
			if (!handler) throw new Error("host requests are only answered while a Cell runs");
			return handler(request);
		};
		answer().then(
			(result) => reply({ status: "ok", result: result ?? null }),
			(error: unknown) => reply({
				status: "error",
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof HostRequestError ? { result: error.result } : {}),
			}),
		);
	}

	/** Resolve the Cell's tool call with what it produced so far. */
	private settle(cell: ActiveCell, status: CellResult["status"]): void {
		cell.settled = true;
		// Namespace inspection must leave background output for the next model-visible Cell.
		const isCell = cell.requestType === "execute";
		const background = isCell ? this.background : this.newBuffer();
		if (isCell) this.background = this.newBuffer();
		const result: CellResult = {
			stdout: cell.stdout.tail,
			stderr: cell.stderr.tail,
			images: [],
			backgroundOutput: background.tail,
			output: { stdout: cell.stdout, stderr: cell.stderr, background },
			result: cell.result,
			error: cell.error,
			names: cell.names,
			status: cell.signal?.aborted ? "aborted" : status,
			durationMs: Date.now() - cell.started,
		};
		cell.resolve(isCell ? this.images.take().then(({ images, notice }) => ({
			...result,
			images,
			...(notice ? { imageNotice: notice } : {}),
		})) : result);
	}

	private notifyOutput(cell: ActiveCell): void {
		cell.onOutput?.({ stdout: cell.stdout, stderr: cell.stderr, background: this.background });
	}

	private newBuffer(): OutputBuffer {
		const limits = this.options.getOutputLimits?.();
		return new OutputBuffer(limits?.maxBytes ?? DEFAULT_MAX_BYTES, limits?.maxLines ?? DEFAULT_MAX_LINES);
	}

	/** Drop Background output of a Kernel that is gone. */
	private resetBackground(): void {
		this.background.dispose();
		this.background = this.newBuffer();
		this.images.reset();
	}

	private clearActive(): void {
		const cell = this.active;
		this.active = undefined;
		cell?.markFinished();
	}

	/** Wait for an interrupted Cell to finish, re-interrupting it; throws KernelBusyError if it will not. */
	private async waitUntilIdle(signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + BUSY_WAIT_MS;
		while (this.active && !signal?.aborted) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new KernelBusyError();
			this.interrupt();
			await Promise.race([this.active.finished, delay(Math.min(BUSY_INTERRUPT_INTERVAL_MS, remaining), signal)]);
		}
	}

	private request(
		request: KernelRequest,
		signal?: AbortSignal,
		onHostRequest?: HostRequestHandler,
		onOutput?: CellOutputListener,
	): Promise<CellResult> {
		const run = this.queue.then(() => this.send(request, signal, onHostRequest, onOutput));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async send(
		request: KernelRequest,
		signal?: AbortSignal,
		onHostRequest?: HostRequestHandler,
		onOutput?: CellOutputListener,
	): Promise<CellResult> {
		await this.waitUntilIdle(signal);
		if (signal?.aborted) {
			return { stdout: "", stderr: "", images: [], backgroundOutput: "", status: "aborted", durationMs: 0 };
		}
		if (!this.child) throw new Error("Kernel is not running");
		return new Promise<CellResult>((resolve, reject) => {
			let abortTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				this.interrupt();
				// A Cell that ignores the interrupt must not hang the turn: return without it, keeping it active.
				abortTimer = setTimeout(() => {
					if (this.active === cell && !cell.settled) this.settle(cell, "aborted");
				}, ABORT_GRACE_MS);
			};
			const cleanup = () => {
				clearTimeout(abortTimer);
				signal?.removeEventListener("abort", onAbort);
			};
			let markFinished = () => {};
			const finished = new Promise<void>((resolve) => {
				markFinished = resolve;
			});
			const cell: ActiveCell = {
				id: randomUUID().replaceAll("-", ""),
				requestType: request.type,
				started: Date.now(),
				signal,
				onHostRequest,
				onOutput,
				stdout: this.newBuffer(),
				stderr: this.newBuffer(),
				settled: false,
				finished,
				markFinished,
				resolve: (result) => {
					cleanup();
					resolve(result);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			};
			this.active = cell;
			signal?.addEventListener("abort", onAbort, { once: true });
			this.write({ ...request, id: cell.id }).catch((error: Error) => {
				if (this.active !== cell) return;
				this.clearActive();
				cell.reject(error);
			});
		});
	}

	/** The Kernel process died or broke the protocol: drop it; the next Cell starts a fresh one. */
	private lose(child: ChildProcess, error: Error): void {
		if (this.child !== child) return;
		const stderr = this.active ? this.stderrForError(this.active.stderr) : "";
		if (stderr) error = new Error(`${error.message}\n\n[Cell stderr]\n${stderr}`, { cause: error });
		this.child = undefined;
		this.starting = undefined;
		this.failPending(error);
		this.resetBackground();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		if (this.readyChild === child) {
			this.readyChild = undefined;
			this.options.onLost?.(error);
		}
	}

	private failPending(error: Error): void {
		this.ready?.reject(error);
		this.ready = undefined;
		const cell = this.active;
		this.clearActive();
		if (cell && !cell.settled) {
			cell.stdout.dispose();
			cell.stderr.dispose();
			cell.reject(error);
		}
	}

	/** The tail of a Cell's stderr, cut to the output limits. */
	private stderrForError(stderr: OutputBuffer): string {
		const limits = this.options.getOutputLimits?.() ?? {};
		return truncateTail(stderr.tail, { maxBytes: limits.maxBytes ?? DEFAULT_MAX_BYTES, maxLines: limits.maxLines ?? DEFAULT_MAX_LINES }).content;
	}

	private write(request: Record<string, unknown>): Promise<void> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("Kernel stdin is not connected"));
		return new Promise<void>((resolve, reject) => {
			const stdin = child.stdin;
			if (!stdin || stdin.destroyed) {
				reject(new Error("Kernel stdin is not connected"));
				return;
			}
			stdin.write(`${JSON.stringify(request)}\n`, (error) => (error ? reject(error) : resolve()));
		}).catch((error: Error) => {
			// A write callback can fail before any stream error or process close event.
			// Retire its owning Kernel now, so the next Cell cannot reuse a broken transport.
			this.lose(child, error);
			throw error;
		});
	}

	private withStderr(message: string): Error {
		return new Error(`${message}. stderr:\n${this.stderrTail.slice(-1024) || "(empty)"}`);
	}
}

/** Why a parsed line is not a valid protocol frame, or undefined. */
function invalidFrameReason(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null || Array.isArray(event)) return "non-object frame";
	const { event: kind, id } = event as Record<string, unknown>;
	if (typeof kind !== "string" || !PROTOCOL_EVENT_KINDS.has(kind)) return "unknown protocol event";
	// done and host_request route strictly by id; an id-less one would leave a request unsettled forever.
	if ((kind === "done" || kind === "host_request") && (typeof id !== "string" || id === "")) {
		return `${kind} frame without id`;
	}
	return undefined;
}

function imagesFromDisplay(data: unknown): CellImage[] {
	if (typeof data !== "object" || data === null) return [];
	return Object.entries(data).flatMap(([mimeType, payload]) =>
		IMAGE_MIME_TYPES.has(mimeType) && typeof payload === "string" ? [{ mimeType, data: payload }] : [],
	);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Resolves after `ms`, or early when `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
