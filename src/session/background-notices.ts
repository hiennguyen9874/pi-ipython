// Background-command notices: the runtime reports a finished Background command (`bash.completed`)
// and a later read of its handle (`bash.consumed`). Notices wait here until pi is idle and go out
// together as one message that starts a turn; a read that comes first withdraws its notice.
//
// Adapted from Unharnessed (crates/uh-core/src/session_engine/wakes.rs and messages.rs at 53bdd8784).
// Copyright (c) 2026 Unharnessed
// MIT License, see LICENSE.

import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { HostRequestHandler } from "../kernel/client.ts";

const BACKGROUND_NOTICE_TYPE = "ipython_bash_done";
/** How long a notice may wait for the commands still running beside it, so they wake the model once. */
const NOTICE_BATCH_MS = 2 * 60 * 1000;
const MAX_NOTICE_TURNS = 5;

const HANDLE_LINE = "Read its output with the handle's .output() or .tail(n), or `await` it.";
const PAUSED_MESSAGE = "Background-command notices paused; they reach the model with your next message.";

interface Notice {
	pid: number;
	command: string;
	exitCode: number;
	timeoutSeconds?: number;
	/** When the host accepted it, on the monotonic clock. */
	receivedAt: number;
}

interface NoticeMessage {
	customType: typeof BACKGROUND_NOTICE_TYPE;
	content: string;
	display: true;
	details: { notices: Omit<Notice, "receivedAt">[] };
}

interface BackgroundNoticeHost {
	/** Pi has no run, retry, or queued continuation. */
	isIdle(): boolean;
	/** Whether a `bash()` command of the current Kernel still runs. */
	hasRunningCommand(): Promise<boolean>;
	/** Send the message so that it starts a turn. */
	send(message: NoticeMessage): void;
	/** Tell the user. */
	notify(message: string): void;
}

export function isCancelledBackgroundNotice(message: { role: string; customType?: string; display?: boolean }): boolean {
	return message.role === "custom" && message.customType === BACKGROUND_NOTICE_TYPE && message.display === false;
}

export class BackgroundNotices {
	/** Set per session: the config switch, in a mode that can start turns. Off: notices are acknowledged and dropped. */
	enabled = false;
	/** Undelivered notices, oldest first. */
	private queue: Notice[] = [];
	private noticeTurns = 0;
	private paused = false;
	private inNoticeTurn = false;
	private deadlineTimer?: ReturnType<typeof setTimeout>;
	private compactionTimer?: ReturnType<typeof setTimeout>;
	private dispatch?: { batch: Set<Notice>; details: NoticeMessage["details"] };
	/** Serializes flushes: each awaits the Kernel's command list. */
	private flushing: Promise<void> = Promise.resolve();

	constructor(private readonly host: BackgroundNoticeHost) {}

	readonly hostHandlers: Readonly<Record<string, HostRequestHandler>> = {
		"bash.completed": async (data) => {
			const notice = parseCompleted(data);
			if (this.enabled) {
				this.queue.push(notice);
				if (this.queue.length === 1) this.armDeadline();
				this.flush();
			}
			return {};
		},
		"bash.consumed": async (data) => {
			const { pid, command } = parseIdentity(data);
			// Pids are reused across handles: match the command too.
			const oldest = this.queue[0];
			this.queue = this.queue.filter((notice) => notice.pid !== pid || notice.command !== command);
			if (oldest !== this.queue[0]) {
				this.armDeadline();
				this.flush();
			}
			return {};
		},
	};

	/** Pi may defer the send behind another prompt. Commit the batch only when pi starts its turn. */
	onRunStart(run: BeforeAgentStartEvent, abort: () => void): NoticeMessage | undefined {
		clearTimeout(this.compactionTimer); // The next settle now owns the retry.
		this.inNoticeTurn = false;
		if (run.messageType === "user") {
			const wasPaused = this.paused;
			this.noticeTurns = 0;
			this.paused = false;
			if (wasPaused && this.queue.length > 0) {
				const batch = this.queue;
				this.queue = [];
				this.armDeadline();
				return noticeMessage(batch);
			}
			return;
		}
		if (run.message.customType !== BACKGROUND_NOTICE_TYPE) return;
		const dispatch = this.dispatch;
		const selected = dispatch && run.message.details === dispatch.details ? dispatch.batch : undefined;
		const batch = selected && !this.paused ? this.queue.filter((notice) => selected.has(notice)) : [];
		if (selected) this.dispatch = undefined;
		if (!selected || batch.length === 0) {
			// Pi cannot retract its deferred trigger. Abort before the model sees it.
			Object.assign(run.message, { content: "", display: false, details: undefined });
			abort();
			return;
		}

		this.queue = this.queue.filter((notice) => !selected.has(notice));
		this.armDeadline();
		Object.assign(run.message, noticeMessage(batch));
		this.inNoticeTurn = true;
		this.noticeTurns++;
	}

	onSettled(aborted: boolean): void {
		if (this.inNoticeTurn && (aborted || this.noticeTurns >= MAX_NOTICE_TURNS)) this.pause();
		this.inNoticeTurn = false;
		this.flush();
	}

	/** Pi emits the manual success hook before clearing its busy flag. */
	afterManualCompaction(): void {
		if (this.paused || !this.enabled) return;
		// shortcut: retry only the idle check while the remaining compaction hooks finish;
		// remove when Pi exposes its post-compaction idle event to extensions.
		clearTimeout(this.compactionTimer);
		this.compactionTimer = setTimeout(() => {
			if (this.host.isIdle()) this.flush();
			else this.afterManualCompaction();
		}, 25);
		this.compactionTimer.unref();
	}

	drop(): void {
		this.queue = [];
		this.dispatch = undefined;
		this.armDeadline();
		clearTimeout(this.compactionTimer);
	}

	reset(): void {
		this.drop();
		this.noticeTurns = 0;
		this.paused = false;
		this.inNoticeTurn = false;
	}

	private armDeadline(): void {
		clearTimeout(this.deadlineTimer);
		const oldest = this.queue[0];
		if (!oldest || this.paused) return;
		const delay = Math.ceil(oldest.receivedAt + NOTICE_BATCH_MS - performance.now());
		if (delay <= 0) return; // Already due; the caller or the next settle checks it.
		// A slow Kernel list must not hold up an already-due batch.
		this.deadlineTimer = setTimeout(() => void this.flushNow().catch(() => undefined), delay);
		this.deadlineTimer.unref();
	}

	private flush(): void {
		this.flushing = this.flushing.then(() => this.flushNow()).catch(() => undefined);
	}

	private async flushNow(): Promise<void> {
		const oldest = this.queue[0];
		if (!oldest || this.paused || this.dispatch || !this.host.isIdle()) return;
		const due = oldest.receivedAt + NOTICE_BATCH_MS;
		if (performance.now() < due && await this.host.hasRunningCommand() && performance.now() < due) return;
		if (this.queue[0] !== oldest || this.paused || this.dispatch || !this.host.isIdle()) return;
		const message = noticeMessage(this.queue);
		this.dispatch = { batch: new Set(this.queue), details: message.details };
		this.host.send(message);
	}

	private pause(): void {
		if (this.paused) return;
		this.paused = true;
		clearTimeout(this.deadlineTimer);
		clearTimeout(this.compactionTimer);
		this.host.notify(PAUSED_MESSAGE);
	}
}

function noticeMessage(notices: Notice[]): NoticeMessage {
	return {
		customType: BACKGROUND_NOTICE_TYPE,
		content: `${notices.map(noticeText).join("\n\n")}\n${HANDLE_LINE}`,
		display: true,
		details: { notices: notices.map(({ receivedAt: _, ...notice }) => notice) },
	};
}

function noticeText({ pid, command, exitCode, timeoutSeconds }: Notice): string {
	const killed = timeoutSeconds === undefined ? "" : `\n\nKilled: still running after its ${timeoutSeconds} s timeout.`;
	return `[bash-done pid:${pid} exit:${exitCode}]\n\nCommand: ${JSON.stringify(command)}${killed}`;
}

function parseIdentity(data: Record<string, unknown>): { pid: number; command: string } {
	const { pid, command } = data;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error(`${data.type} pid must be a positive integer`);
	if (typeof command !== "string" || command === "") throw new Error(`${data.type} command must be a non-empty string`);
	return { pid, command };
}

function parseCompleted(data: Record<string, unknown>): Notice {
	const { exitCode, timeoutSeconds } = data;
	if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) throw new Error("bash.completed exitCode must be an integer");
	if (timeoutSeconds !== undefined && timeoutSeconds !== null && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
		throw new Error("bash.completed timeoutSeconds must be a positive number");
	}
	return {
		...parseIdentity(data),
		exitCode,
		...(typeof timeoutSeconds === "number" ? { timeoutSeconds } : {}),
		receivedAt: performance.now(),
	};
}
