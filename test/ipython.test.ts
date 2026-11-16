import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

test("the session's active tools are exactly ipython", async () => {
	h = await createHarness();
	expect(h.session.getActiveToolNames()).toEqual(["ipython"]);
});

test("no Kernel exists before the first Cell, and the Kernel is gone after shutdown", async () => {
	h = await createHarness();
	expect(kernelPids()).toEqual([]);

	await h.runCells("1");
	expect(kernelPids()).toHaveLength(1);

	await h.dispose();
	h = undefined;
	expect(kernelPids()).toEqual([]);
});

test("Python state persists between Cells", async () => {
	h = await createHarness();
	const [first, second] = await h.runCells("x = 41", "x + 1");
	expect(first?.isError).toBe(false);
	expect(resultText(second!)).toBe("42");
});

test("top-level await works", async () => {
	h = await createHarness();
	const [r] = await h.runCells("import asyncio\nawait asyncio.sleep(0)\nawait asyncio.sleep(0, result='awaited')");
	expect(resultText(r!)).toBe("'awaited'");
});

test("an error returns name, message, and traceback with the offending line; the next Cell still works", async () => {
	h = await createHarness();
	const [failed, next] = await h.runCells("y = 1\nraise ValueError('bad value')", "y");
	expect(failed?.isError).toBe(true);
	const text = resultText(failed!);
	expect(text).toContain("Traceback (most recent call last)");
	expect(text).toContain("raise ValueError('bad value')");
	expect(text).toContain("ValueError: bad value");

	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("1");
});

test("stdout and stderr are reported separately", async () => {
	h = await createHarness();
	const [r] = await h.runCells("import sys\nprint('to out')\nprint('to err', file=sys.stderr)");
	expect(resultText(r!)).toBe("to out\n[stderr]\nto err");
	expect(r?.details).toMatchObject({ stdout: "to out\n", stderr: "to err\n", status: "ok" });
	expect((r?.details as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
});

test("Kernel death during a pending write fails the Cell without crashing pi", async () => {
	h = await createHarness();
	await h.runCells("1");
	const [pid] = kernelPids();
	expect(pid).toBeDefined();
	// Stop reads so the large request cannot drain before the process is killed.
	process.kill(pid!, "SIGSTOP");
	const kill = setTimeout(() => process.kill(pid!, "SIGKILL"), 100);
	try {
		const [failed] = await h.runCells(`#${"x".repeat(8 * 1024 * 1024)}\n42`);
		expect(failed?.isError).toBe(true);
		const [next] = await h.runCells("42");
		expect(next?.isError).toBe(false);
		expect(resultText(next!)).toBe("42");
	} finally {
		clearTimeout(kill);
		// Also clean up if the assertion or request fails before the timer fires.
		try {
			process.kill(pid!, "SIGKILL");
		} catch {}
	}
});

test("the Kernel runs in the session cwd", async () => {
	h = await createHarness();
	const [r] = await h.runCells("import os\nos.getcwd()");
	expect(resultText(r!)).toBe(`'${h.cwd}'`);
});
