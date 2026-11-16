// Orphan-process journal: every pi host appends the Kernels it spawns (and the runtime appends its
// `bash()` children) to a per-host JSONL file. When a host dies without tearing its Kernel down,
// the next host to start reaps every process still marked active in the dead host's journal.
//
// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa,
// packages/coding-agent/src/core/orphan-process-journal.ts and core/session-lease.ts),
// adapted to one journal file per pi host.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isProcessAlive } from "./process.ts";

/** Env var the runtime reads to journal its `bash()` children (runtime/src/rlm/bash.py). */
export const ORPHAN_JOURNAL_ENV = "UNHARNESSED_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface JournalRecord {
	version: 1;
	pid: number;
	/** Set by the runtime on its `bash()` children; absent on Kernel records written by the host. */
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
}

/** This host's journal in `dir`. The name carries the host's start id, so a reused pid gets a new file. */
export function hostJournalPath(dir: string): string {
	hostTag ??= startIdTag(getProcessStartId(process.pid));
	return path.join(dir, `${process.pid}-${hostTag}.jsonl`);
}
let hostTag: string | undefined;

export function recordProcess(journal: string, pid: number, active: boolean): void {
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: JournalRecord = { version: 1, pid, ...(processStartId ? { processStartId } : {}), active };
	try {
		mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
		appendFileSync(journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	} catch {
		// Process tracking must not make a successfully spawned Kernel fail.
	}
}

/** After a Kernel exits: kill what is left of its process group and the `bash()` children it journaled. */
export function reapKernel(journal: string | undefined, kernelPid: number): void {
	const groupReaped = killExitedGroup(kernelPid);
	if (!journal) return;
	if (groupReaped) recordProcess(journal, kernelPid, false);
	try {
		for (const record of activeRecords(journal)) {
			if (record.kernelPid === kernelPid && reap(record)) recordProcess(journal, record.pid, false);
		}
	} catch {
		// Retain the journal if reading it failed; exit handlers must not throw.
	}
}

/** Reap the active processes of every journal in `dir` whose host is gone, then drop those journals. */
export function reapDeadHosts(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const match = /^(\d+)-(\w+)\.jsonl$/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (isProcessAlive(pid)) {
			const current = getProcessStartId(pid);
			if (!current || match[2] === "unknown" || startIdTag(current) === match[2]) continue;
		}
		const journal = path.join(dir, name);
		try {
			const records = activeRecords(journal);
			let complete = true;
			for (const record of records) {
				if (!reap(record)) complete = false;
			}
			if (complete) rmSync(journal, { force: true });
		} catch {
			// Keep unreadable or unresolved journals for the next startup.
		}
	}
}

/** Latest record per pid that is still marked active. */
function activeRecords(journal: string): JournalRecord[] {
	const contents = readFileSync(journal, "utf8");
	const latest = new Map<number, JournalRecord>();
	for (const line of contents.split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as Partial<JournalRecord>;
			if (record.version === 1 && Number.isInteger(record.pid) && record.pid! > 0 && typeof record.active === "boolean") {
				latest.set(record.pid!, record as JournalRecord);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	return [...latest.values()].filter((record) => record.active);
}

/**
 * Kill a journaled process tree (Kernels and `bash()` children lead their own process groups).
 * A live pid is only killed when its start id proves it is still the journaled process.
 */
function reap(record: JournalRecord): boolean {
	// A historical PGID may now belong to an unrelated group. Only the immediate
	// child-exit callback may clean a group after its leader has died.
	if (!isProcessAlive(record.pid)) return true;
	const current = getProcessStartId(record.pid);
	if (!record.processStartId || !current) return false;
	if (current !== record.processStartId) return true; // pid reused: ours is gone
	if (process.platform === "win32") {
		const taskkill = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
		return spawnSync(taskkill, ["/F", "/T", "/PID", String(record.pid)], { stdio: "ignore", windowsHide: true, timeout: 10_000 }).status === 0;
	}
	try {
		process.kill(-record.pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(record.pid, "SIGKILL");
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Clean a just-exited child's group, never a historical journal entry.
 * shortcut: after a crash, dead leaders' groups cannot be identified safely;
 * use an OS-owned supervisor if cleanup without a surviving leader is required.
 */
function killExitedGroup(pid: number): boolean {
	if (process.platform === "win32") return true;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	return true;
}

function startIdTag(startId: string | undefined): string {
	return startId ? createHash("sha256").update(startId).digest("hex").slice(0, 16) : "unknown";
}

/**
 * Stable identity of a running process (its start time), or undefined. Byte-for-byte the format
 * the runtime journals (`_process_start_id` in runtime/src/rlm/bash.py).
 */
export function getProcessStartId(pid: number): string | undefined {
	if (process.platform === "win32") {
		const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const out = spawnSync(
			powershell,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`],
			{ encoding: "utf8", timeout: 5_000, windowsHide: true },
		).stdout?.trim();
		return out && /^\d+$/.test(out) ? `win:${out}` : undefined;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// No /proc (macOS, BSD): fall back to ps.
	}
	// `lstart` renders in the subprocess timezone and locale, so pin both for a durable identity.
	const out = spawnSync(process.platform === "darwin" ? "/bin/ps" : "ps", ["-p", String(pid), "-o", "lstart="], {
		encoding: "utf8",
		timeout: 5_000,
		env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
	}).stdout?.trim();
	return out ? `ps:${out}` : undefined;
}
