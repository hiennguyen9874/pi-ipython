import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

// Keep real processes, but allow fault injection at the OS transport boundary.
vi.mock("node:child_process", { spy: true });

let h: Harness | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await h?.dispose();
	h = undefined;
	vi.clearAllMocks();
});

test("a failed stdin write retires the Kernel before stream-error or close events", async () => {
	h = await createHarness();
	await h.runCells("x = 41");
	const [pid] = kernelPids();
	expect(pid).toBeDefined();
	const child = vi.mocked(spawn).mock.results.find((r) => r.type === "return" && r.value.pid === pid)!.value;

	// Reproduce the callback-only ECANCELED path: neither stream error nor process close
	// has notified the client yet. Only this Kernel's transport fails; the replacement is real.
	vi.spyOn(child.stdin!, "write").mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1) as (error: Error) => void;
		queueMicrotask(() => callback(Object.assign(new Error("write ECANCELED"), { code: "ECANCELED" })));
		return false;
	});

	const [failed, next] = await h.runCells("42", "42");
	expect(failed?.isError).toBe(true);
	expect(resultText(failed!)).toContain("write ECANCELED");
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("42");

	const [state] = await h.runCells("'x' in globals()");
	expect(resultText(state!)).toBe("False");
});
