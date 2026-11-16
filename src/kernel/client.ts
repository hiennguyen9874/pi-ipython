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

export const REPL_PROTOCOL_VERSION = 3;
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_STDERR_TAIL_CHARS = 8 * 1024;
// A line that cannot complete within this ceiling is corruption, not output worth buffering until OOM.
const MAX_PROTOCOL_LINE_CHARS = 32 * 1024 * 1024;
// The exact event vocabulary of protocol v3: an unknown kind is corruption, not a newer runtime.
const PROTOCOL_EVENT_KINDS = new Set(["ready", "stdout", "stderr", "result", "display", "host_request", "error", "done"]);
// Cap for output with no owning Cell, buffered until the next Cell finishes.
const MAX_BACKGROUND_OUTPUT_CHARS = 64 * 1024;
/** Image MIME types models accept; other display payloads are ignored. */
export const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface CellError {
	ename: string;
	evalue: string;
	traceback: string[];
}

export interface CellImage {
	mimeType: string;
	/** base64 */
	data: string;
}

export interface CellResult {
	stdout: string;
	stderr: string;
	/** Images this Cell emitted through `display` events. */
	images: CellImage[];
	/** stdout/stderr with no owning Cell (threads, subprocesses, tasks of finished Cells) since the last Cell. */
	backgroundOutput: string;
	/** repr of the trailing expression, when it is not None. */
	result?: string;
	error?: CellError;
	status: "ok" | "error" | "aborted";
	durationMs: number;
}

export interface KernelClientOptions {
	cwd: string;
	/** Resolves the Python that has the Kernel runtime installed (may build the venv). */
	resolvePython: () => Promise<string>;
	/** Code run once right after the Kernel starts, before any Cell. */
	bootstrapCode?: string;
	/** Extra environment for the Kernel process. */
	env?: Record<string, string>;
}

interface ActiveCell {
	id: string;
	started: number;
	signal?: AbortSignal;
	stdout: string;
	stderr: string;
	images: CellImage[];
	result?: string;
	error?: CellError;
	resolve: (result: CellResult) => void;
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
	private backgroundOutput = "";
	/** Bumped by every shutdown so a stale in-flight start never keeps its process. */
	private generation = 0;

	constructor(private readonly options: KernelClientOptions) {}

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

	/** Run one Cell, starting the Kernel first if needed. */
	async execute(code: string, signal?: AbortSignal): Promise<CellResult> {
		await this.start();
		return this.request(code, signal);
	}

	/** Raise KeyboardInterrupt in the running Cell. */
	interrupt(): void {
		this.write({ type: "interrupt" }).catch(() => undefined);
	}

	/** Stop the Kernel: graceful shutdown request, then SIGKILL after a grace period. */
	async shutdown(): Promise<void> {
		this.generation++;
		const child = this.child;
		this.child = undefined;
		this.starting = undefined;
		this.failPending(new Error("Kernel was shut down"));
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
		this.backgroundOutput = "";
		const child = spawn(python, ["-m", "rlm.repl"], {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...this.options.env,
				...(process.platform === "win32" ? { PYTHONUTF8: "1" } : {}),
				// The runtime exits when this pid dies, so a crashed pi leaves no Kernel behind.
				UNHARNESSED_KERNEL_OWNER_PID: String(process.pid),
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
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
				const result = await this.request(this.options.bootstrapCode);
				if (result.status !== "ok") {
					const details = [result.stderr, result.error?.traceback.join("")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize the Kernel runtime:\n${details}`);
				}
			}
		} catch (error) {
			if (this.child === child) await this.shutdown();
			throw error;
		}
		if (generation !== this.generation) throw new Error("Kernel was shut down during startup");
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
			// No host handlers yet (v4): answer so the awaiting Cell fails instead of hanging.
			this.write({
				type: "host_reply",
				id: event.id,
				data: { status: "error", error: "host requests are not supported by pi-ipython" },
			}).catch(() => undefined);
			return;
		}
		const cell = this.active;
		if (!cell || event.id !== cell.id) {
			// Output without this Cell's id (threads, subprocesses, other Cells) is not credited to it:
			// it is buffered and reported as background output with the next finished Cell.
			if (type === "stdout" || type === "stderr") this.appendBackgroundOutput(asString(event.text));
			return;
		}
		if (type === "stdout") cell.stdout += asString(event.text);
		else if (type === "stderr") cell.stderr += asString(event.text);
		else if (type === "result") cell.result = asString(event.text);
		else if (type === "display") {
			const data = event.data;
			if (typeof data !== "object" || data === null) return;
			for (const [mimeType, payload] of Object.entries(data)) {
				if (IMAGE_MIME_TYPES.has(mimeType) && typeof payload === "string") cell.images.push({ mimeType, data: payload });
			}
		}
		else if (type === "error") {
			cell.error = {
				ename: asString(event.ename) || "Error",
				evalue: asString(event.evalue),
				traceback: Array.isArray(event.traceback) ? event.traceback.filter((t) => typeof t === "string") : [],
			};
		} else if (type === "done") {
			this.active = undefined;
			const backgroundOutput = this.backgroundOutput;
			this.backgroundOutput = "";
			cell.resolve({
				stdout: cell.stdout,
				stderr: cell.stderr,
				images: cell.images,
				backgroundOutput,
				result: cell.result,
				error: cell.error,
				status: cell.signal?.aborted ? "aborted" : event.status === "ok" && !cell.error ? "ok" : "error",
				durationMs: Date.now() - cell.started,
			});
		}
	}

	private request(code: string, signal?: AbortSignal): Promise<CellResult> {
		const run = this.queue.then(() => this.send(code, signal));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private send(code: string, signal?: AbortSignal): Promise<CellResult> {
		if (signal?.aborted) {
			return Promise.resolve({ stdout: "", stderr: "", images: [], backgroundOutput: "", status: "aborted", durationMs: 0 });
		}
		if (!this.child) return Promise.reject(new Error("Kernel is not running"));
		return new Promise<CellResult>((resolve, reject) => {
			const onAbort = () => this.interrupt();
			const cleanup = () => signal?.removeEventListener("abort", onAbort);
			const cell: ActiveCell = {
				id: randomUUID().replaceAll("-", ""),
				started: Date.now(),
				signal,
				stdout: "",
				stderr: "",
				images: [],
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
			this.write({ type: "execute", id: cell.id, code }).catch((error: Error) => {
				if (this.active !== cell) return;
				this.active = undefined;
				cell.reject(error);
			});
		});
	}

	/** The Kernel process died or broke the protocol: drop it; the next Cell starts a fresh one. */
	private lose(child: ChildProcess, error: Error): void {
		if (this.child !== child) return;
		this.child = undefined;
		this.starting = undefined;
		this.failPending(error);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}

	private failPending(error: Error): void {
		this.ready?.reject(error);
		this.ready = undefined;
		const cell = this.active;
		this.active = undefined;
		cell?.reject(error);
	}

	private write(request: Record<string, unknown>): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) return Promise.reject(new Error("Kernel stdin is not connected"));
		return new Promise((resolve, reject) => {
			stdin.write(`${JSON.stringify(request)}\n`, (error) => (error ? reject(error) : resolve()));
		});
	}

	private appendBackgroundOutput(text: string): void {
		const marker = "\n[background output truncated]\n";
		if (this.backgroundOutput.endsWith(marker)) return;
		this.backgroundOutput += text;
		if (this.backgroundOutput.length > MAX_BACKGROUND_OUTPUT_CHARS) {
			this.backgroundOutput = this.backgroundOutput.slice(0, MAX_BACKGROUND_OUTPUT_CHARS) + marker;
		}
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

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
