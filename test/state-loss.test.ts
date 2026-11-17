import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { STATE_LOST_NOTICE } from "../src/index.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

/** A Cell that defines `x`, then kills its Kernel shortly after returning. */
const DIE_SOON = "x = 41\nimport os, threading\nthreading.Timer(0.2, lambda: os._exit(9)).start()";

test("a Kernel that dies between Cells: the next Cell does not run and returns the State-loss notice", async () => {
	h = await createHarness();
	await h.runCells(DIE_SOON);
	await sleep(1_000);

	const [blocked] = await h.runCells("open('ran', 'w').close()");
	expect(blocked?.isError).toBe(true);
	expect(resultText(blocked!)).toContain(STATE_LOST_NOTICE);
	expect(resultText(blocked!)).toContain("Cell not run");
	expect(resultText(blocked!)).toContain("Kernel exited");
	expect(existsSync(join(h.cwd, "ran"))).toBe(false);

	const [next] = await h.runCells("globals().get('x', 'state gone')");
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("'state gone'");
});

// A shell script stands in for the project venv's Python.
test.skipIf(process.platform === "win32")("a Kernel that fails to start gets a plain error, never the State-loss notice", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".venv", "bin"), { recursive: true });
			writeFileSync(join(cwd, ".venv", "bin", "python"), "#!/bin/sh\necho broken python >&2\nexit 3\n", { mode: 0o755 });
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ python: { source: "project" } }));
		},
	});
	const [first, second] = await h.runCells("1", "2");
	for (const failed of [first!, second!]) {
		expect(failed.isError).toBe(true);
		expect(resultText(failed)).toContain("Kernel exited (exit code 3)");
		expect(resultText(failed)).toContain("broken python");
		expect(resultText(failed)).not.toContain(STATE_LOST_NOTICE);
		expect(resultText(failed)).not.toContain("Cell not run");
	}
});

test("a session-level State-loss notice counts as delivered: the first Cell after it runs", async () => {
	h = await createHarness();
	await h.runCells(DIE_SOON);
	await sleep(1_000);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
	await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });

	const [next] = await h.runCells("40 + 2");
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("42");
});

test("a Cell that kills its Kernel carries the State-loss notice, and the next Cell runs in a fresh Kernel", async () => {
	h = await createHarness();
	const [crashed, next] = await h.runCells("x = 41\nimport os, sys, time\nprint('crash diagnostic', file=sys.stderr, flush=True)\ntime.sleep(0.2)\nos._exit(17)", "globals().get('x', 'state gone')");
	expect(crashed?.isError).toBe(true);
	expect(resultText(crashed!)).toMatch(new RegExp(`^${STATE_LOST_NOTICE}\n\nKernel exited`));
	expect(resultText(crashed!)).not.toContain("Cell not run");
	expect(resultText(crashed!)).toContain("crash diagnostic");
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("'state gone'");
});
