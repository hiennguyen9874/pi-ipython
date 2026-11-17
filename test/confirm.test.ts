import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

function confirmOn({ cwd }: { cwd: string }): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ confirmEachCell: true }));
}

/** A UI whose confirm dialog answers `answer` and records what it was shown. */
function withConfirm(answer: boolean) {
	const prompts: { title: string; message: string }[] = [];
	const ui = {
		confirm: async (title: string, message: string) => {
			prompts.push({ title, message });
			return answer;
		},
	};
	return { prompts, ui };
}

/** Code that leaves a marker file, so a test can tell whether the Cell ran. */
const touch = (file: string) => `open(${JSON.stringify(file)}, "w").close()\n"ran"`;

test("with confirmEachCell on, the user sees the Cell's code and approving runs it", async () => {
	const { prompts, ui } = withConfirm(true);
	h = await createHarness({ setup: confirmOn, ui });
	const marker = join(h.cwd, "ran");
	const code = touch(marker);
	const [r] = await h.runCells(code);
	expect(prompts).toHaveLength(1);
	expect(prompts[0]!.message).toContain(code);
	expect(r?.isError).toBe(false);
	expect(resultText(r!)).toBe("'ran'");
	expect(existsSync(marker)).toBe(true);
});

test("rejecting a Cell returns a rejection result without running it or starting a Kernel", async () => {
	const { prompts, ui } = withConfirm(false);
	h = await createHarness({ setup: confirmOn, ui });
	const marker = join(h.cwd, "ran");
	const [r] = await h.runCells(touch(marker));
	expect(prompts).toHaveLength(1);
	expect(r?.isError).toBe(true);
	expect(resultText(r!)).toContain("rejected by user");
	expect(existsSync(marker)).toBe(false);
	expect(kernelPids()).toEqual([]);
});

test("with confirmEachCell on and no UI, the Cell is refused with the reason", async () => {
	h = await createHarness({ setup: confirmOn });
	const marker = join(h.cwd, "ran");
	const [r] = await h.runCells(touch(marker));
	expect(r?.isError).toBe(true);
	expect(resultText(r!)).toContain("confirmEachCell");
	expect(resultText(r!)).toContain("no UI");
	expect(existsSync(marker)).toBe(false);
});

test("a Kernel that dies during approval blocks the Cell without side effects", async () => {
	let pid: number | undefined;
	h = await createHarness({
		setup: confirmOn,
		ui: { confirm: async () => {
			if (pid !== undefined) {
				process.kill(pid, "SIGKILL");
				await sleep(200);
				pid = undefined;
			}
			return true;
		} },
	});
	const [first] = await h.runCells("import os; os.getpid()");
	pid = Number(resultText(first!));
	const marker = join(h.cwd, "ran");
	const [blocked, next] = await h.runCells(touch(marker), "40 + 2");
	expect(blocked?.isError).toBe(true);
	expect(resultText(blocked!)).toContain("Cell not run");
	expect(existsSync(marker)).toBe(false);
	expect(resultText(next!)).toBe("42");
});

test("with confirmEachCell off (the default), Cells run without prompting", async () => {
	const { prompts, ui } = withConfirm(false);
	h = await createHarness({ ui });
	const marker = join(h.cwd, "ran");
	const [r] = await h.runCells(touch(marker));
	expect(prompts).toEqual([]);
	expect(resultText(r!)).toBe("'ran'");
	expect(existsSync(marker)).toBe(true);
});
