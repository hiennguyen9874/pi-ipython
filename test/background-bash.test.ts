import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

test("a Background command that finishes between Cells leaves no warning in the next Cell", async () => {
	h = await createHarness();
	await h.runCells("h = bash('sleep 0.2; echo hi; touch finished')");
	while (!existsSync(join(h.cwd, "finished"))) await sleep(20);
	// Let the runtime report the completion to the host while no Cell runs.
	await sleep(500);
	const [read, next] = await h.runCells("h.output()", "1");
	expect(resultText(read!)).toBe("'hi\\n'");
	expect(read?.details).toMatchObject({ backgroundOutput: "" });
	expect(resultText(next!)).toBe("1");
});

test("a Background command that finishes while another Cell runs leaves no warning", async () => {
	h = await createHarness();
	const [, running, next] = await h.runCells(
		"h = bash('sleep 0.2; echo hi')",
		"await asyncio.sleep(1)\nprint('own')",
		"h.output()",
	);
	expect(resultText(running!)).toBe("own");
	expect(resultText(next!)).toBe("'hi\\n'");
	expect(next?.details).toMatchObject({ backgroundOutput: "" });
});
