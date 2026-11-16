// The model-facing `ipython` tool: runs one Cell in the session's Kernel and shapes the result.
//
// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa,
// packages/coding-agent/src/core/tools/ipython.ts), rebuilt on pi.registerTool.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatSize, type ToolDefinition, type TruncationOptions, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CellResult, KernelClient } from "../kernel/client.ts";

export const IPYTHON_TOOL_NAME = "ipython";

/** Run once in every new Kernel: binds `bash` and `mcp` into the namespace. */
export const KERNEL_BOOTSTRAP_CODE = `
import asyncio
import os as _pi_ipython_os

_pi_ipython_os.environ["NO_COLOR"] = "1"

import rlm as _pi_ipython_rlm
bash = _pi_ipython_rlm.bash
import rlm.mcp as mcp
`.trim();

const ipythonSchema = Type.Object({
	code: Type.String({ description: "Python code to run in the persistent Kernel." }),
});

export interface IpythonToolDetails extends CellResult {
	/** Set when the text was truncated: the temp file holding the full text. */
	fullOutputPath?: string;
}

/** Model-facing text: stdout, then stderr (labelled), then the trailing expression's repr, then the traceback. */
export function formatCellResult(r: CellResult): string {
	const parts: string[] = [];
	if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
	if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
	if (r.result !== undefined) parts.push(r.result);
	if (r.error) {
		const traceback = r.error.traceback.join("").replace(/\n$/, "");
		parts.push(traceback || `${r.error.ename}: ${r.error.evalue}`);
	}
	if (r.status === "aborted") parts.push("[Cell aborted]");
	if (r.backgroundOutput) parts.push(`[background output]\n${r.backgroundOutput.replace(/\n$/, "")}`);
	return parts.join("\n") || "(no output)";
}

/** Keep the tail within the limits (tracebacks and results come last); spill the full text to a temp file. */
export function truncateCellText(text: string, limits: TruncationOptions): { text: string; fullOutputPath?: string } {
	const t = truncateTail(text, limits);
	if (!t.truncated) return { text };
	const fullOutputPath = join(tmpdir(), `pi-ipython-${randomUUID()}.log`);
	writeFileSync(fullOutputPath, text);
	const shown = t.lastLinePartial
		? `the last ${formatSize(t.outputBytes)} of the last line`
		: `the last ${t.outputLines} of ${t.totalLines} lines`;
	return {
		text: `${t.content}\n\n[Output truncated (${formatSize(t.totalBytes)} total): showing ${shown}. Full output: ${fullOutputPath}]`,
		fullOutputPath,
	};
}

export function createIpythonTool(
	getKernel: () => KernelClient,
	getOutputLimits: () => TruncationOptions = () => ({}),
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	return {
		name: IPYTHON_TOOL_NAME,
		label: "ipython",
		description:
			"Run Python code in a persistent Python Kernel. Variables, functions, and imports persist between calls. Top-level `await` works. The output contains stdout, stderr, the repr of the trailing expression, and errors with tracebacks. Long output is truncated to its tail, with the full text saved to a temp file. Images emitted with `from rlm.repl import emit; emit({'image/png': base64_str})` are returned as images. Output from background threads, tasks, and subprocesses is reported under [background output] in the next result.",
		promptSnippet: "ipython - persistent Python Kernel for code, data, and state",
		parameters: ipythonSchema,
		// One Kernel runs one Cell at a time.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const r = await getKernel().execute(params.code, signal);
			const { text, fullOutputPath } = truncateCellText(formatCellResult(r), getOutputLimits());
			const images: ImageContent[] = r.images.map((i) => ({ type: "image", ...i }));
			const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
			return {
				content,
				details: { ...r, fullOutputPath },
				isError: r.status !== "ok",
			};
		},
	};
}
