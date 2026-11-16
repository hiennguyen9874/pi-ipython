import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const fullOutputPath = (text: string) => text.match(/Full output: (\S+)\]$/)?.[1];

test("output over the line limit is truncated to its tail, with the full text in a temp file", async () => {
	h = await createHarness();
	const [r] = await h.runCells("for i in range(3000): print(f'line {i}')");
	const text = resultText(r!);
	expect(text).toContain("line 2999");
	expect(text).not.toContain("line 999\n");
	expect(text).toContain("showing the last 2000 of 3000 lines");
	const path = fullOutputPath(text);
	expect(path).toBeDefined();
	const full = readFileSync(path!, "utf8").split("\n");
	expect(full).toHaveLength(3000);
	expect(full[0]).toBe("line 0");
	expect(full[2999]).toBe("line 2999");
});

test("output limits come from config", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: { maxBytes: 100 } }));
		},
	});
	const [r] = await h.runCells("print('x' * 50)\nprint('y' * 50)\nprint('z' * 50)");
	const text = resultText(r!);
	expect(text.startsWith(`${"z".repeat(50)}\n\n[Output truncated`)).toBe(true);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toContain("x".repeat(50));
});

test("output at the limit is returned unchanged", async () => {
	h = await createHarness();
	const [r] = await h.runCells("for i in range(2000): print(i)");
	expect(resultText(r!)).toBe(Array.from({ length: 2000 }, (_, i) => i).join("\n"));
});

test("an emitted image/png payload is returned as an image block; other MIME types are not", async () => {
	h = await createHarness();
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const [r] = await h.runCells(`from rlm.repl import emit\nemit({'image/png': '${png}', 'text/html': '<b>x</b>'})\nprint('plotted')`);
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("plotted");
	const images = r!.content.filter((b): b is ImageContent => b.type === "image");
	expect(images).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
});

test("output from a task that finishes after its Cell appears under background output in the next Cell", async () => {
	h = await createHarness();
	const [first, second] = await h.runCells(
		"import asyncio\nasync def later():\n    await asyncio.sleep(0.2)\n    print('late')\nt = asyncio.create_task(later())\nprint('first')",
		"await asyncio.sleep(0.5)\nprint('own')",
	);
	expect(resultText(first!)).toBe("first");
	expect(resultText(second!)).toBe("own\n[background output]\nlate");
	expect(second?.details).toMatchObject({ stdout: "own\n", backgroundOutput: "late\n" });
});

test("output from a thread is attached to the next Cell, not mixed into the Cell running then", async () => {
	h = await createHarness();
	const [, second, third] = await h.runCells(
		"import threading\nthreading.Timer(0.2, lambda: print('from thread')).start()",
		"import time\ntime.sleep(0.5)\nprint('own')",
		"1",
	);
	expect(resultText(second!)).toBe("own\n[background output]\nfrom thread");
	expect(resultText(third!)).toBe("1");
});
