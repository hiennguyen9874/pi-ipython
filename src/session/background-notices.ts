// Background-command notices: the runtime reports a finished Background command (`bash.completed`)
// and a later read of its handle (`bash.consumed`). Notices wait here until pi is idle and go out
// together as one message that starts a turn; a read that comes first withdraws its notice.
//
// Adapted from Unharnessed (crates/uh-core/src/session_engine/wakes.rs and messages.rs at 53bdd8784).
// Copyright (c) 2026 Unharnessed
// MIT License, see LICENSE.

import type { HostRequestHandler } from "../kernel/client.ts";

export const BACKGROUND_NOTICE_TYPE = "ipython_bash_done";
/** How long a notice may wait for the commands still running beside it, so they wake the model once. */
export const NOTICE_BATCH_MS = 2 * 60 * 1000;
/** Wake-up turns in a row, without a user message, before notices stop starting turns. */
export const MAX_WAKE_TURNS = 5;

const HANDLE_LINE = "Read its output with the handle's .output() or .tail(n), or `await` it.";
const PAUSED_MESSAGE = "Background-command notices paused; they reach the model with your next message.";

interface Notice {
	pid: number;
	command: string;
	exitCode: number;
	timeoutSeconds?: number;
	/** When the host accepted it (epoch ms). */
	receivedAt: number;
}

export interface NoticeMessage {
	customType: typeof BACKGROUND_NOTICE_TYPE;
	content: string;
	display: true;
	details: { notices: Omit<Notice, "receivedAt">[] };
}

export interface BackgroundNoticeHost {
	/** Pi has no run, retry, or queued continuation. */
	isIdle(): boolean;
	/** Whether a `bash()` command of the current Kernel still runs. */
	hasRunningCommand(): Promise<boolean>;
	/** Send the message so that it starts a turn. */
	wake(message: NoticeMessage): void;
	/** Tell the user. */
	notify(message: string): void;
}

/** The run that is starting, as `before_agent_start` describes it. */
export interface RunStart {
	messageType: "user" | "custom";
	message?: { customType?: string };
}

export class BackgroundNotices {
	/** Set per session: the config switch, in a mode that can start turns. Off: notices are acknowledged and dropped. */
	enabled = false;
	/** Undelivered notices, oldest first. */
	private queue: Notice[] = [];
	private wakeTurns = 0;
	private paused = false;
	private inWakeTurn = false;
	private timer?: ReturnType<typeof setTimeout>;
	/** Serializes flushes: each awaits the Kernel's command list. */
	private flushing: Promise<void> = Promise.resolve();

	constructor(private readonly host: BackgroundNoticeHost) {}

	readonly hostHandlers: Readonly<Record<string, HostRequestHandler>> = {
		"bash.completed": async (data) => {
			const notice = parseCompleted(data);
			if (this.enabled) {
				this.queue.push(notice);
				this.flush();
			}
			return {};
		},
		"bash.consumed": async (data) => {
			const { pid, command } = parseIdentity(data);
			// Pids are reused across handles: match the command too.
			this.queue = this.queue.filter((notice) => notice.pid !== pid || notice.command !== command);
			return {};
		},
	};

	/** A run starts. Returns the queued notices to add to a run the user started. */
	onRunStart(run: RunStart): NoticeMessage | undefined {
		this.inWakeTurn = run.messageType === "custom" && run.message?.customType === BACKGROUND_NOTICE_TYPE;
		if (this.inWakeTurn) this.wakeTurns++;
		if (run.messageType !== "user") return undefined;
		this.wakeTurns = 0;
		this.paused = false;
		return this.take();
	}

	/** Pi settled after a run. A wake-up turn the user aborted pauses notices until the user's next message. */
	onSettled(aborted: boolean): void {
		if (aborted && this.inWakeTurn) this.pause();
		this.inWakeTurn = false;
		this.flush();
	}

	/** The Kernel is gone, and its commands with it: drop their notices. */
	drop(): void {
		this.queue = [];
		clearTimeout(this.timer);
	}

	/** A new session: nothing queued, no wake-up turns counted. */
	reset(): void {
		this.drop();
		this.wakeTurns = 0;
		this.paused = false;
		this.inWakeTurn = false;
	}

	private flush(): void {
		this.flushing = this.flushing.then(() => this.flushNow()).catch(() => undefined);
	}

	private async flushNow(): Promise<void> {
		clearTimeout(this.timer);
		if (!this.enabled || this.paused || this.queue.length === 0 || !this.host.isIdle()) return;
		// Go once no command runs any more, or once the oldest notice has waited long enough.
		const wait = this.queue[0]!.receivedAt + NOTICE_BATCH_MS - Date.now();
		if (wait > 0 && await this.host.hasRunningCommand()) {
			this.timer = setTimeout(() => this.flush(), wait);
			this.timer.unref?.();
			return;
		}
		if (this.queue.length === 0 || !this.host.isIdle()) return;
		if (this.wakeTurns >= MAX_WAKE_TURNS) return this.pause();
		this.host.wake(this.take()!);
	}

	private pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.host.notify(PAUSED_MESSAGE);
	}

	/** Empty the queue into one message, or undefined when it is empty. */
	private take(): NoticeMessage | undefined {
		const notices = this.queue;
		this.queue = [];
		clearTimeout(this.timer);
		if (notices.length === 0) return undefined;
		return {
			customType: BACKGROUND_NOTICE_TYPE,
			content: `${notices.map(noticeText).join("\n\n")}\n${HANDLE_LINE}`,
			display: true,
			details: { notices: notices.map(({ receivedAt: _, ...notice }) => notice) },
		};
	}
}

function noticeText({ pid, command, exitCode, timeoutSeconds }: Notice): string {
	const killed = timeoutSeconds === undefined ? "" : `\n\nKilled: still running after its ${timeoutSeconds} s timeout.`;
	return `[bash-done pid:${pid} exit:${exitCode}]\n\nCommand: ${JSON.stringify(command)}${killed}`;
}

function parseIdentity(data: Record<string, unknown>): { pid: number; command: string } {
	const { pid, command } = data;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(`${data.type} pid must be a positive integer`);
	if (typeof command !== "string" || command === "") throw new Error(`${data.type} command must be a non-empty string`);
	return { pid, command };
}

function parseCompleted(data: Record<string, unknown>): Notice {
	const { exitCode, timeoutSeconds } = data;
	if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) throw new Error("bash.completed exitCode must be an integer");
	if (timeoutSeconds !== undefined && timeoutSeconds !== null && (typeof timeoutSeconds !== "number" || !(timeoutSeconds > 0))) {
		throw new Error("bash.completed timeoutSeconds must be a positive number");
	}
	return {
		...parseIdentity(data),
		exitCode,
		...(typeof timeoutSeconds === "number" ? { timeoutSeconds } : {}),
		receivedAt: Date.now(),
	};
}
