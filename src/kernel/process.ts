// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa).
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

/** Includes processes that exist but cannot be signalled by this user. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
