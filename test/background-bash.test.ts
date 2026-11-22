import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, resultText, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

test("the Command log rotates at commandLog.maxBytes", async () => {
	h = await createHarness({ setup: (dirs) => writeConfigs(dirs, { commandLog: { maxBytes: 2_500_000 } }) });
	// 3.9 MB of output: the log moves to .1 at 2.5 MB and the rest goes to a new log.
	const [result] = await h.runCells("r = await bash('seq 1 600000')\n[l for l in r.output.splitlines() if 'dropped' in l][0]");
	const match = /latest output in (\S+\.log)\.1 and \1\]/.exec(resultText(result!));
	expect(match).not.toBeNull();
	const [sizes] = await h.runCells(`import os\n[os.path.getsize(p) for p in (${JSON.stringify(match![1] + ".1")}, ${JSON.stringify(match![1])})]`);
	const [rotated, current] = JSON.parse(resultText(sizes!)) as number[];
	expect(rotated! + current!).toBe(Array.from({ length: 600_000 }, (_, i) => `${i + 1}\n`).join("").length);
	expect(rotated).toBeLessThanOrEqual(2_500_000);
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
