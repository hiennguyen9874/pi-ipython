// One stream of Cell output with bounded memory: a tail in memory, the full text spooled to a file
// once the tail has to drop text.
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
	/** The spool holding the full output, once the tail had to drop text. */
	spoolPath?: string;
}

/**
 * Output text kept to a tail of at least `2 × maxBytes`. Any tail cut to the output limits from
 * the text, alone or after other text, equals the same cut of the full output: a line that starts
 * before the kept tail is longer than `maxBytes`, so a cut stops before reaching it.
 */
export class OutputBuffer {
	private text = "";
	private textBytes = 0;
	private trimmed = false;
	private fd?: number;
	private spoolPath?: string;
	/** Why the full output is lost: the spool could not be written. */
	spoolError?: string;
	totalBytes = 0;
	newlines = 0;
	endsWithNewline = false;
	private readonly keepBytes: number;

	constructor(maxBytes: number) {
		this.keepBytes = Math.max(2 * maxBytes, 1);
	}

	append(text: string): void {
		if (!text) return;
		const bytes = Buffer.byteLength(text);
		this.totalBytes += bytes;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.newlines++;
		this.endsWithNewline = text.endsWith("\n");
		if (this.fd !== undefined) this.writeSpool(text);
		this.text += text;
		this.textBytes += bytes;
		// Trim with slack so the cost of trimming stays amortized.
		if (this.textBytes > 2 * this.keepBytes) this.trim();
	}

	/** The kept tail, at most `2 × maxBytes` once text was dropped. */
	get tail(): string {
		if (this.trimmed && this.textBytes > this.keepBytes) this.trim();
		return this.text;
	}

	/** True when the tail is the whole output. */
	get complete(): boolean {
		return !this.trimmed;
	}

	snapshot(): OutputBufferSnapshot {
		return {
			tail: this.tail,
			truncated: this.trimmed,
			totalBytes: this.totalBytes,
			totalLines: this.newlines + (this.totalBytes > 0 && !this.endsWithNewline ? 1 : 0),
			spoolPath: this.spoolPath,
		};
	}

	/** Write the full output to `fd`, without one trailing newline when `dropTrailingNewline`. Throws when it is lost. */
	writeTo(fd: number, dropTrailingNewline = false): void {
		const drop = dropTrailingNewline && this.endsWithNewline ? 1 : 0;
		if (!this.trimmed) {
			writeAll(fd, Buffer.from(drop ? this.text.slice(0, -1) : this.text, "utf8"));
			return;
		}
		if (this.fd === undefined) throw new Error(this.spoolError ?? "the full output was not kept");
		const end = this.totalBytes - drop;
		const chunk = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(end, 1)));
		for (let position = 0; position < end;) {
			const read = readSync(this.fd, chunk, 0, Math.min(chunk.length, end - position), position);
			if (read === 0) throw new Error("the spooled output is shorter than expected");
			writeAll(fd, chunk.subarray(0, read));
			position += read;
		}
	}

	/** Close and delete the spool. */
	dispose(): void {
		this.closeSpool();
	}

	private trim(): void {
		// Text is dropped from memory only once the full output is safe on disk.
		if (!this.trimmed && this.spoolError === undefined) this.openSpool();
		const buffer = Buffer.from(this.text, "utf8");
		let start = buffer.length - this.keepBytes;
		while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
		this.text = buffer.subarray(start).toString("utf8");
		this.textBytes = buffer.length - start;
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
		this.writeSpool(this.text);
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
		if (this.spoolPath) rmSync(this.spoolPath, { force: true });
		this.spoolPath = undefined;
	}
}

/** writeSync may write less than asked. */
export function writeAll(fd: number, data: Buffer): void {
	for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
