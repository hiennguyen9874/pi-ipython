// One stream of Cell output with bounded memory: its start and its tail in memory, the full text
// spooled to a file once an output limit is crossed.
//
// Adapted from pi's OutputAccumulator (packages/coding-agent/src/core/tools/output-accumulator.ts),
// which pi does not export: the input is decoded text, and the spool is written synchronously so a
// slow disk cannot queue output in memory.
// Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COPY_CHUNK_BYTES = 64 * 1024;

export interface OutputBufferSnapshot {
	/** The output's tail: the whole output unless `truncated`. */
	tail: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
	/** The spool holding the full output once a limit was crossed. */
	spoolPath?: string;
}

/**
 * Keep twice the output limits, with room to strip a trailing newline. A later cut to the
 * actual limits will stop before reaching any incomplete first line.
 * The start is kept up to the limits (`maxBytes` UTF-16 units, at least as many bytes), so a cut
 * keeping part of the limits for the start stops before its end too.
 */
export class OutputBuffer {
	private text = "";
	private headText = "";
	private headNewlines = 0;
	private textBytes = 0;
	private textNewlines = 0;
	private pendingHigh = "";
	private trimmed = false;
	private fd?: number;
	private spoolPath?: string;
	private spoolError?: string;
	totalBytes = 0;
	newlines = 0;
	endsWithNewline = false;
	private readonly keepBytes: number;
	private readonly keepLines: number;

	constructor(private readonly maxBytes: number, private readonly maxLines: number) {
		// Formatting strips one newline; truncateTail also excludes a final newline from line widths.
		this.keepBytes = Math.max(2 * maxBytes, maxBytes + 3);
		this.keepLines = Math.max(2 * maxLines, maxLines + 2);
	}

	append(text: string): void {
		if (!text) return;
		const previousHigh = this.pendingHigh;
		const last = text.charCodeAt(text.length - 1);
		this.pendingHigh = isHighSurrogate(last) ? text.slice(-1) : "";
		// Two separately encoded surrogate halves take six bytes; together they take four.
		const bytes = Buffer.byteLength(text) - (previousHigh && isLowSurrogate(text.charCodeAt(0)) ? 2 : 0);
		const newlines = countNewlines(text);
		this.totalBytes += bytes;
		this.newlines += newlines;
		this.endsWithNewline = last === 10;
		if (this.fd !== undefined) {
			this.writeSpool(previousHigh + (this.pendingHigh ? text.slice(0, -1) : text));
		}
		this.captureHead(text);
		this.text += text;
		this.textBytes += bytes;
		this.textNewlines += newlines;
		if (this.fd === undefined && !this.spoolError && (this.totalBytes > this.maxBytes || this.totalLines > this.maxLines)) {
			this.openSpool();
		}
		// Batch trims so the cost stays amortized; snapshots compact to the retained limits.
		if (this.textBytes > 2 * this.keepBytes || this.textNewlines > 2 * this.keepLines) this.trim();
	}

	get tail(): string {
		if (this.textBytes > this.keepBytes || this.textNewlines > this.keepLines) this.trim();
		return this.text;
	}

	/** The output's start: the whole output unless `truncated`. */
	get head(): string {
		return this.trimmed ? this.headText : this.text;
	}

	/** True once the tail dropped the output's start, so `head` and `tail` are not contiguous. */
	get truncated(): boolean {
		return this.trimmed;
	}

	private get totalLines(): number {
		return this.newlines + (this.totalBytes > 0 && !this.endsWithNewline ? 1 : 0);
	}

	snapshot(): OutputBufferSnapshot {
		return {
			tail: this.tail,
			truncated: this.trimmed,
			totalBytes: this.totalBytes,
			totalLines: this.totalLines,
			spoolPath: this.spoolPath,
		};
	}

	/** Write the full output to `fd`, without one trailing newline when `dropTrailingNewline`. Throws when it is lost. */
	writeTo(fd: number, dropTrailingNewline = false): void {
		const drop = dropTrailingNewline && this.endsWithNewline ? 1 : 0;
		if (this.spoolError) throw new Error(this.spoolError);
		if (!this.trimmed) {
			writeAll(fd, Buffer.from(drop ? this.text.slice(0, -1) : this.text, "utf8"));
			return;
		}
		if (this.fd === undefined) throw new Error("the full output was not kept");
		const end = this.totalBytes - drop - (this.pendingHigh ? 3 : 0);
		const chunk = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(end, 1)));
		for (let position = 0; position < end;) {
			const read = readSync(this.fd, chunk, 0, Math.min(chunk.length, end - position), position);
			if (read === 0) throw new Error("the spooled output is shorter than expected");
			writeAll(fd, chunk.subarray(0, read));
			position += read;
		}
		if (this.pendingHigh) writeAll(fd, Buffer.from(this.pendingHigh, "utf8"));
	}

	/** Close and delete the spool. */
	dispose(): void {
		this.closeSpool();
	}

	private captureHead(text: string): void {
		const room = this.maxBytes - this.headText.length;
		if (room <= 0 || this.headNewlines >= this.maxLines) return;
		let piece = text.length > room ? text.slice(0, room) : text;
		for (let i = piece.indexOf("\n"); i !== -1; i = piece.indexOf("\n", i + 1)) {
			if (++this.headNewlines === this.maxLines) {
				piece = piece.slice(0, i + 1);
				break;
			}
		}
		this.headText += piece;
	}

	private trim(): void {
		let start = this.text.length;
		let bytes = 0;
		let newlines = 0;
		let lines = 0;
		while (start > 0 && bytes < this.keepBytes) {
			const char = this.text.charCodeAt(start - 1);
			if (char === 10) {
				if (start !== this.text.length && ++lines === this.keepLines) break;
				newlines++;
			}
			start--;
			if (isLowSurrogate(char) && isHighSurrogate(this.text.charCodeAt(start - 1))) {
				start--;
				bytes += 4;
			} else {
				bytes += char < 0x80 ? 1 : char < 0x800 ? 2 : 3;
			}
		}
		if (start === 0) return;
		this.text = this.text.slice(start);
		this.textBytes = bytes;
		this.textNewlines = newlines;
		this.trimmed = true;
	}

	private openSpool(): void {
		const path = join(tmpdir(), `pi-ipython-spool-${randomBytes(8).toString("hex")}.log`);
		try {
			// `wx` never follows a link someone else placed at the path.
			this.fd = openSync(path, "wx+", 0o600);
			this.spoolPath = path;
		} catch (error) {
			this.spoolError = errorMessage(error);
			return;
		}
		this.writeSpool(this.pendingHigh ? this.text.slice(0, -1) : this.text);
	}

	private writeSpool(text: string): void {
		try {
			writeAll(this.fd!, Buffer.from(text, "utf8"));
		} catch (error) {
			this.spoolError = errorMessage(error);
			this.closeSpool();
		}
	}

	private closeSpool(): void {
		if (this.fd !== undefined) {
			try {
				closeSync(this.fd);
			} catch {}
			this.fd = undefined;
		}
		if (this.spoolPath) {
			try {
				rmSync(this.spoolPath, { force: true });
				this.spoolPath = undefined;
			} catch {} // Retry on disposal if a failed write triggered this cleanup.
		}
	}
}

/** writeSync may write less than asked. */
export function writeAll(fd: number, data: Buffer): void {
	for (let offset = 0; offset < data.length;) {
		const written = writeSync(fd, data, offset, data.length - offset);
		if (written === 0) throw new Error("could not write output");
		offset += written;
	}
}

export function countNewlines(text: string): number {
	let count = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
	return count;
}

function isHighSurrogate(char: number): boolean {
	return char >= 0xd800 && char <= 0xdbff;
}

function isLowSurrogate(char: number): boolean {
	return char >= 0xdc00 && char <= 0xdfff;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
