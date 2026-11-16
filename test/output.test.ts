import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
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
	if (process.platform !== "win32") expect(statSync(path!).mode & 0o777).toBe(0o600);
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

test("a spill failure preserves output, images, execution status, and completed side effects", async () => {
	h = await createHarness();
	await h.runCells("saved = 0");
	const missing = join(h.cwd, "missing-temp-dir");
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, missing);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const [r, next] = await h.runCells(
		`from rlm.repl import emit\nsaved = 42\nemit({'image/png': '${png}'})\nprint('kept\\n' * 2100, end='')`,
		"saved",
	);
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toContain("kept");
	expect(resultText(r!)).toContain("Full output could not be saved");
	expect(r?.content.some((b) => b.type === "image")).toBe(true);
	expect(r?.details).not.toHaveProperty("fullOutputPath", expect.any(String));
	expect(resultText(next!)).toBe("42");
	const [failed] = await h.runCells("print('kept\\n' * 2100, end='')\nraise ValueError('original Python error')");
	expect(failed?.isError).toBe(true);
	expect(resultText(failed!)).toContain("ValueError: original Python error");
	expect(resultText(failed!)).toContain("Full output could not be saved");
});

test("large background output keeps its heading and spills all text beyond the old buffer cap", async () => {
	h = await createHarness();
	const [r, next] = await h.runCells(
		"import threading\ndef noisy():\n    print('start')\n    for i in range(2200): print(f'{i:04d}:' + 'x' * 40)\n    print('END')\nt = threading.Thread(target=noisy)\nt.start()\nt.join()",
		"1",
	);
	const text = resultText(r!);
	expect(text.startsWith("[background output]\n")).toBe(true);
	expect(text).toContain("END");
	const displayed = text.split("\n\n[Output truncated")[0]!;
	expect(displayed.split("\n").length).toBeLessThanOrEqual(2000);
	expect(Buffer.byteLength(displayed)).toBeLessThanOrEqual(50 * 1024);
	const full = readFileSync(fullOutputPath(text)!, "utf8");
	expect(full).toBe(
		"[background output]\nstart\n" +
			Array.from({ length: 2200 }, (_, i) => `${String(i).padStart(4, "0")}:${"x".repeat(40)}\n`).join("") + "END",
	);
	expect(resultText(next!)).toBe("1");
});

test.each([
	{ maxLines: 4 },
	{ maxBytes: 64 },
])("background attribution survives configured limits %j", async (limits) => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: limits }));
		},
	});
	const [r] = await h.runCells(
		"import threading\nt = threading.Thread(target=lambda: print('background line\\n' * 20, end=''))\nt.start()\nt.join()",
	);
	const text = resultText(r!);
	const displayed = text.split("\n\n[Output truncated")[0]!;
	expect(displayed.startsWith("[background output]\n")).toBe(true);
	expect(displayed.split("\n").length).toBeLessThanOrEqual(limits.maxLines ?? 2000);
	expect(Buffer.byteLength(displayed)).toBeLessThanOrEqual(limits.maxBytes ?? 50 * 1024);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe("[background output]\n" + "background line\n".repeat(20).trimEnd());
});

test("literal background truncation markers do not discard subsequent output", async () => {
	h = await createHarness();
	const [r] = await h.runCells(
		"import threading\ndef write():\n    print('\\n[background output truncated]')\n    print('still here')\nt = threading.Thread(target=write)\nt.start()\nt.join()",
	);
	expect(resultText(r!)).toBe("[background output]\n\n[background output truncated]\nstill here");
});

test("background displays are delivered once, including displays emitted between Cells", async () => {
	h = await createHarness();
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const [joined] = await h.runCells(
		`import threading\nfrom rlm.repl import emit\nt = threading.Thread(target=lambda: emit({'image/png': '${png}', 'text/html': 'ignored'}))\nt.start()\nt.join()`,
	);
	expect(joined?.content.filter((b) => b.type === "image")).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
	await h.runCells(`threading.Timer(0.1, lambda: emit({'image/png': '${png}'})).start()`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const [next, last] = await h.runCells("1", "2");
	expect(next?.content.filter((b) => b.type === "image")).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
	expect(last?.content.filter((b) => b.type === "image")).toEqual([]);
});
