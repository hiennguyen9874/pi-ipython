import fs, { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

const fullOutputPath = (text: string) => text.match(/, full output in (\S+)\]/)?.[1];
/** The text within the output limits: without elision markers and the Background output heading. */
const counted = (text: string) => text.split("\n").filter((l) => !/^\[… .* elided.*\]$/.test(l) && l !== "[background output]").join("\n");

test("output over the line limit keeps its start and end around a marker, with the full text in a Spill file", async () => {
	h = await createHarness();
	const [r] = await h.runCells("for i in range(3000): print(f'line {i}')");
	const text = resultText(r!);
	const path = fullOutputPath(text);
	const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`).join("\n");
	expect(text).toBe(`${lines(0, 400)}\n[… 1000 lines elided, full output in ${path}]\n${lines(1400, 3000)}`);
	expect(r?.details).toMatchObject({ fullOutputPath: path });
	expect(path).toBeDefined();
	if (process.platform !== "win32") expect(statSync(path!).mode & 0o777).toBe(0o600);
	const full = readFileSync(path!, "utf8").split("\n");
	expect(full).toHaveLength(3000);
	expect(full[0]).toBe("line 0");
	expect(full[2999]).toBe("line 2999");
});

test("a byte-only cut keeps a short first line before an oversized tail", async () => {
	h = await createHarness();
	const [r] = await h.runCells("print('WARNING')\nprint('x' * 100000 + 'END')");
	const text = resultText(r!);
	expect(text).toMatch(/^WARNING\n\[… .* elided, full output in /);
	expect(text.endsWith("END")).toBe(true);
	expect(Buffer.byteLength(counted(text))).toBeLessThanOrEqual(50 * 1024);
});

test("a single oversized line keeps both ends without cutting a Unicode character", async () => {
	h = await createHarness();
	const [r] = await h.runCells("print('BEGIN' + '😀' * 16000 + 'END', end='')");
	const text = resultText(r!);
	expect(text).toMatch(/^BEGIN(?:😀)+\n\[… [^\n]+ elided, full output in [^\n]+\]\n(?:😀)+END$/u);
	expect(Buffer.byteLength(counted(text))).toBeLessThanOrEqual(50 * 1024);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe("BEGIN" + "😀".repeat(16000) + "END");
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
	expect(text).toBe(`${"x".repeat(20)}\n[… 82B elided, full output in ${fullOutputPath(text)}]\n${"z".repeat(50)}`);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toContain("x".repeat(50));
});

test("the line limit opens a spool during the Cell and bounds the retained tail", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: { maxLines: 2 } }));
		},
	});
	const temp = join(h.cwd, "spools");
	mkdirSync(temp);
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temp);
	const [r] = await h.runCells(
		"from pathlib import Path\nimport time\nfor i in range(3): print(i)\nfor _ in range(100):\n    if list(Path('spools').glob('pi-ipython-spool-*')): break\n    time.sleep(0.01)\nelse: raise AssertionError('no spool after crossing the line limit')\nfor i in range(3, 30): print(i)",
	);
	expect(r?.isError).toBe(false);
	const text = resultText(r!);
	expect(text).toMatch(/^\[… 28 lines elided, full output in \S+\]\n28\n29$/);
	expect((r!.details as { stdout: string }).stdout).toBe("26\n27\n28\n29\n");
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe(Array.from({ length: 30 }, (_, i) => i).join("\n"));
});

test("small byte limits preserve the partial-line notice and spooled Unicode across frames", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: { maxBytes: 1 } }));
		},
	});
	const results = await h.runCells(
		"print('a😀', end='')",
		"print('prefix', end='')\nprint('\\ud83d', end='')\nprint('\\ude00', end='')",
		"import sys\nprint('prefix\\n\\n', file=sys.stderr)",
	);
	for (const [r, full] of [[results[0]!, "a😀"], [results[1]!, "prefix😀"]] as const) {
		const text = resultText(r);
		expect(text).toBe(`[… ${Buffer.byteLength(full)}B elided, full output in ${fullOutputPath(text)}]`);
		expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe(full);
	}
	expect(resultText(results[2]!)).toMatch(/^\[… 2 lines elided, full output in \S+\]\n$/);
});

test("a one-line limit preserves the suffix when the stream ends with a blank line", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: { maxBytes: 4, maxLines: 1 } }));
		},
	});
	const [blank, empty] = await h.runCells("print('\\na\\n😀\\n界\\n')", "pass");
	expect(resultText(blank!)).toMatch(/^\[… 3 lines elided, full output in \S+\]\n界$/);
	expect(resultText(empty!)).toMatch(/^\[… 7B elided, full output in \S+\]\nput\)$/);
	expect(readFileSync(fullOutputPath(resultText(empty!))!, "utf8")).toBe("(no output)");
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
	expect(resultText(r!)).toMatch(/\n\[… 100 lines elided, full output could not be saved: .+\]\n/);
	expect(r?.content.some((b) => b.type === "image")).toBe(true);
	expect(r?.details).not.toHaveProperty("fullOutputPath", expect.any(String));
	expect(resultText(next!)).toBe("42");
	const [failed] = await h.runCells("print('kept\\n' * 2100, end='')\nraise ValueError('original Python error')");
	expect(failed?.isError).toBe(true);
	expect(resultText(failed!)).toMatch(/ValueError: original Python error$/);
	expect(resultText(failed!)).toContain("full output could not be saved");
});

test("large background output keeps its heading and spills all text beyond the old buffer cap", async () => {
	h = await createHarness();
	const [r, next] = await h.runCells(
		"import threading\ndef noisy():\n    print('start')\n    for i in range(2200): print(f'{i:04d}:' + 'x' * 40)\n    print('END')\nt = threading.Thread(target=noisy)\nt.start()\nt.join()",
		"1",
	);
	const text = resultText(r!);
	expect(text.startsWith("[background output]\nstart\n0000:")).toBe(true);
	expect(text).toMatch(/\n\[… \d+ lines elided, full output in \S+\]\n\d{4}:/);
	expect(text.endsWith("\nEND")).toBe(true);
	const displayed = counted(text);
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
	expect(text.startsWith("[background output]\n")).toBe(true);
	const displayed = counted(text);
	expect(displayed.split("\n").length).toBeLessThanOrEqual(limits.maxLines ?? 2000);
	expect(Buffer.byteLength(displayed)).toBeLessThanOrEqual(limits.maxBytes ?? 50 * 1024);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe("[background output]\n" + "background line\n".repeat(20).trimEnd());
});

test("a traceback stays at the end of the Cell's own output when its output and Background output are both huge", async () => {
	h = await createHarness();
	const [r] = await h.runCells(
		"import threading\nt = threading.Thread(target=lambda: [print(f'bg {i}') for i in range(5000)])\nt.start()\nt.join()\nfor i in range(5000): print(f'own {i}')\nraise ValueError('boom')",
	);
	expect(r?.isError).toBe(true);
	const text = resultText(r!);
	const [own, background] = text.split("\n[background output]\n");
	expect(own!.startsWith("own 0\nown 1\n")).toBe(true);
	expect(own).toMatch(/\nown 4999\nTraceback[^]*ValueError: boom$/);
	expect(own).toMatch(/\n\[… \d+ lines elided, full output in \S+\]\n/);
	expect(background!.startsWith("bg 0\nbg 1\n")).toBe(true);
	expect(background).toMatch(/\n\[… \d+ lines elided, full output in \S+\]\n/);
	expect(background!.endsWith("\nbg 4999")).toBe(true);
	expect(counted(text).split("\n").length).toBeLessThanOrEqual(2000);
	const full = readFileSync(fullOutputPath(text)!, "utf8");
	expect(full.startsWith("own 0\n")).toBe(true);
	expect(full).toContain("ValueError: boom\n[background output]\nbg 0\n");
});

test.each([
	[{ maxLines: 1 }, "ValueError: boom"],
	[{ maxBytes: 2 }, "om"],
] as const)("a failing Cell gets the last available output space before Background output with %j", async (limits, tail) => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: limits }));
		},
	});
	const [r] = await h.runCells(
		"import threading\nt = threading.Thread(target=lambda: print('bg payload'))\nt.start()\nt.join()\nraise ValueError('boom')",
	);
	const text = resultText(r!);
	expect(r?.isError).toBe(true);
	expect(counted(text)).toBe(tail);
	expect(text).toContain("\n[background output]\n[…");
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toContain("ValueError: boom\n[background output]\nbg payload");
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


const PNG_HELPER = [
	"import base64, struct, zlib",
	"from rlm.repl import emit",
	"def png(r):",
	"    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)",
	"    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)",
	"    body = chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes([0, r, 0, 0]))) + chunk(b'IEND', b'')",
	"    return base64.b64encode(b'\\x89PNG\\r\\n\\x1a\\n' + body).decode()",
].join("\n");

/** Expected text of a Cell printing `count` numbered 50-byte lines. */
const numberedLines = (count: number) => Array.from({ length: count }, (_, i) => `${String(i).padStart(6, "0")}${"x".repeat(43)}\n`).join("");
const NUMBERED_LINES_CODE = (count: number) => `for i in range(${count}): print(f'{i:06d}' + 'x' * 43)`;

test("a Cell printing far beyond the limits keeps bounded details and session entries, and a byte-exact spill file", async () => {
	h = await createHarness();
	const count = 200_000;
	const [r] = await h.runCells(`import sys\n${NUMBERED_LINES_CODE(count)}\nprint('last words', file=sys.stderr)`);
	const text = resultText(r!);
	expect(text.startsWith(`000000${"x".repeat(43)}\n000001`)).toBe(true);
	expect(text).toMatch(/\n\[… \d+ lines elided, full output in \S+\]\n\d{6}x{43}\n/);
	expect(text.endsWith("[stderr]\nlast words")).toBe(true);
	expect(counted(text).split("\n").length).toBeLessThanOrEqual(2000);
	expect(Buffer.byteLength(counted(text))).toBeLessThanOrEqual(50 * 1024);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe(`${numberedLines(count).slice(0, -1)}\n[stderr]\nlast words`);
	const details = r!.details as { stdout: string; stderr: string };
	expect(Buffer.byteLength(details.stdout)).toBeLessThanOrEqual(2 * 50 * 1024);
	expect(details.stdout.endsWith(`${String(count - 1).padStart(6, "0")}${"x".repeat(43)}\n`)).toBe(true);
	expect(details.stderr).toBe("last words\n");
	expect(JSON.stringify(h.fileEntries()).length).toBeLessThan(1024 * 1024);
});

test("noisy background output is bounded in details and spilled byte-exact", async () => {
	h = await createHarness();
	const count = 200_000;
	const [r] = await h.runCells(
		`import threading\nt = threading.Thread(target=lambda: [print(f'{i:06d}' + 'x' * 43) for i in range(${count})])\nt.start()\nt.join()\nprint('own')`,
	);
	const text = resultText(r!);
	// The Cell's own output is not crowded out: Background output is cut on its own.
	expect(text.startsWith(`own\n[background output]\n000000${"x".repeat(43)}\n`)).toBe(true);
	expect(text.endsWith(`${String(count - 1).padStart(6, "0")}${"x".repeat(43)}`)).toBe(true);
	expect(Buffer.byteLength(counted(text))).toBeLessThanOrEqual(50 * 1024);
	expect(readFileSync(fullOutputPath(text)!, "utf8")).toBe(`own\n[background output]\n${numberedLines(count).slice(0, -1)}`);
	expect(Buffer.byteLength((r!.details as { backgroundOutput: string }).backgroundOutput)).toBeLessThanOrEqual(2 * 50 * 1024);
});

test("intermediate spools are removed: only the final spill file remains, and none after a Kernel crash", async () => {
	h = await createHarness();
	const temp = join(h.cwd, "temp");
	mkdirSync(temp);
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temp);
	const [r] = await h.runCells(`import sys\n${NUMBERED_LINES_CODE(20_000)}\nfor i in range(20_000): print(i, file=sys.stderr)`);
	expect(readdirSync(temp).map((name) => join(temp, name))).toEqual([fullOutputPath(resultText(r!))]);
	rmSync(fullOutputPath(resultText(r!))!);
	await h.runCells(`import os, threading\nfrom pathlib import Path\ndef noisy():\n    ${NUMBERED_LINES_CODE(20_000)}\nt = threading.Thread(target=noisy)\nt.start()\nt.join()\nassert list(Path('temp').glob('pi-ipython-spool-*'))\n${NUMBERED_LINES_CODE(20_000)}\nos._exit(3)`);
	expect(readdirSync(temp)).toEqual([]);
});

test("a spool failure mid-Cell keeps the tail and reports that the full output could not be saved", async () => {
	h = await createHarness();
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, join(h.cwd, "missing-temp-dir"));
	const [r] = await h.runCells(`${NUMBERED_LINES_CODE(20_000)}\n'still ok'`);
	expect(r?.isError).toBe(false);
	const text = resultText(r!);
	expect(text.endsWith("'still ok'")).toBe(true);
	expect(text).toContain("full output could not be saved");
	expect(r?.details).not.toHaveProperty("fullOutputPath", expect.any(String));
});

test("a write and cleanup failure after opening the spool does not fail the Cell", async () => {
	h = await createHarness();
	await h.runCells("ready = True");
	const temp = join(h.cwd, "spools");
	mkdirSync(temp);
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temp);
	let spoolFd: number | undefined;
	let spoolWrites = 0;
	let failedRemoval = false;
	const { openSync, writeSync, rmSync } = fs;
	const open = vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
		const fd = openSync(path, flags, mode);
		if (String(path).includes("pi-ipython-spool-")) spoolFd = fd;
		return fd;
	});
	const write = vi.spyOn(fs, "writeSync").mockImplementation(new Proxy(writeSync, {
		apply(target, thisArg, args) {
			if (args[0] === spoolFd && ++spoolWrites === 2) {
				spoolFd = undefined;
				throw new Error("spool disk full");
			}
			return Reflect.apply(target, thisArg, args);
		},
	}));
	const remove = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
		if (!failedRemoval && String(path).includes("pi-ipython-spool-")) {
			failedRemoval = true;
			throw new Error("spool removal temporarily denied");
		}
		rmSync(path, options);
	});
	syncBuiltinESMExports();
	try {
		const [r] = await h.runCells(NUMBERED_LINES_CODE(3000) + "\nprint('still ok')");
		expect(r?.isError).toBe(false);
		expect(resultText(r!)).toContain("still ok");
		expect(resultText(r!)).toContain("full output could not be saved: spool disk full]");
		expect(failedRemoval).toBe(true);
		expect(readdirSync(temp)).toEqual([]);
	} finally {
		open.mockRestore();
		write.mockRestore();
		remove.mockRestore();
		syncBuiltinESMExports();
	}
});

test("a result keeps the last 8 images, counting background images, and says how many were dropped", async () => {
	h = await createHarness();
	const [r, expected] = await h.runCells(
		`${PNG_HELPER}\nimport threading\nfor i in range(5):\n    t = threading.Thread(target=lambda: emit({'image/png': png(2*i)}))\n    t.start()\n    t.join()\n    emit({'image/png': png(2*i + 1)})\nprint('plotted')`,
		"' '.join(png(i) for i in range(2, 10))",
	);
	const images = r!.content.filter((b): b is ImageContent => b.type === "image").map((b) => b.data);
	expect(images.join(" ")).toBe(resultText(expected!).slice(1, -1));
	expect(resultText(r!)).toBe("plotted\n\n[2 images dropped: over the 8-image limit]");
	expect(r?.details).toMatchObject({ imageNotice: "[2 images dropped: over the 8-image limit]" });
});

test("an image too large to send that cannot be resized is dropped with a notice", async () => {
	h = await createHarness();
	const [r] = await h.runCells("from rlm.repl import emit\nemit({'image/png': 'A' * (5 * 1024 * 1024)})\nprint('done')");
	expect(r!.content.some((b) => b.type === "image")).toBe(false);
	expect(resultText(r!)).toBe("done\n\n[1 image dropped: too large to send]");
});
