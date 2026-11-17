import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { KERNEL_RESTART_NOTICE } from "../src/tool/ipython-tool.ts";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

/** Ignore interrupts before publishing `started`; the runtime restores its handler for the next Cell. */
function stubbornCell(dir: string): string {
	return [
		"import os, signal, time",
		"signal.signal(signal.SIGINT, signal.SIG_IGN)",
		`open(${JSON.stringify(join(dir, "started"))}, "w").close()`,
		`while not os.path.exists(${JSON.stringify(join(dir, "release"))}):`,
		"    time.sleep(0.02)",
	].join("\n");
}

/** Have the model run `code`, abort (Esc) once `started` exists, and return the Cell's result. */
async function runAndAbort(harness: Harness, code: string, started: string): Promise<ToolResultMessage> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const before = harness.session.messages.length;
	const run = harness.session.prompt("run it");
	const deadline = Date.now() + 10_000;
	while (!existsSync(started)) {
		if (Date.now() > deadline) throw new Error("Cell did not start");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await harness.session.abort();
	await run;
	return harness.session.messages.slice(before).find((m): m is ToolResultMessage => m.role === "toolResult")!;
}

function withChoice(choose: () => string | undefined) {
	const prompts: { title: string; options: string[] }[] = [];
	const ui = {
		select: async (title: string, options: string[]) => {
			prompts.push({ title, options });
			return choose();
		},
	};
	return { prompts, ui };
}

// Windows cannot interrupt synchronous Cells (see runtime/src/rlm/repl.md).
test.skipIf(process.platform === "win32")("aborting a while True Cell raises KeyboardInterrupt and keeps Python state", async () => {
	h = await createHarness();
	await h.runCells("x = 41");
	const started = join(h.cwd, "started");
	const aborted = await runAndAbort(h, `open(${JSON.stringify(started)}, "w").close()\nwhile True:\n    pass`, started);
	expect(aborted.isError).toBe(true);
	expect(resultText(aborted)).toContain("KeyboardInterrupt");

	const [next] = await h.runCells("x + 1");
	expect(resultText(next!)).toBe("42");
});

test("aborting an await-suspended Cell raises KeyboardInterrupt and keeps Python state", async () => {
	h = await createHarness();
	await h.runCells("x = 41");
	const started = join(h.cwd, "started");
	const aborted = await runAndAbort(h, `import asyncio\nopen(${JSON.stringify(started)}, "w").close()\nawait asyncio.sleep(3600)`, started);
	expect(aborted.isError).toBe(true);
	expect(resultText(aborted)).toContain("KeyboardInterrupt");

	const [next] = await h.runCells("x + 1");
	expect(resultText(next!)).toBe("42");
});

test("Kill still tells the model state was lost when the replacement Kernel dies", async () => {
	const { prompts, ui } = withChoice(() => "Kill kernel and restart");
	h = await createHarness({ ui });
	const [first] = await h.runCells("x = 41\nimport os; os.getpid()");
	const pid = Number(resultText(first!));
	await runAndAbort(h, stubbornCell(h.cwd), join(h.cwd, "started"));

	const [failed] = await h.runCells("import os; os._exit(17)");
	expect(prompts).toHaveLength(1);
	expect(failed?.isError).toBe(true);
	expect(resultText(failed!)).toContain(KERNEL_RESTART_NOTICE);
	expect(resultText(failed!)).toContain("Kernel exited");
	expect(kernelPids()).not.toContain(pid);

	const [next] = await h.runCells("globals().get('x', 'state gone')");
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("'state gone'");
	expect(resultText(next!)).not.toContain(KERNEL_RESTART_NOTICE);
}, 60_000);

test("a Cell ignoring the interrupt leads to a wait/kill choice; Kill restarts the Kernel and tells the model", async () => {
	const { prompts, ui } = withChoice(() => "Kill kernel and restart");
	h = await createHarness({ ui });
	const [first] = await h.runCells("x = 41\nimport os; os.getpid()");
	const pid = Number(resultText(first!));
	const aborted = await runAndAbort(h, stubbornCell(h.cwd), join(h.cwd, "started"));
	expect(aborted.isError).toBe(true);

	const [next] = await h.runCells("x");
	expect(prompts).toHaveLength(1);
	expect(prompts[0]!.options).toEqual(["Wait and preserve state", "Kill kernel and restart"]);
	const text = resultText(next!);
	expect(text).toContain(KERNEL_RESTART_NOTICE);
	expect(text).toContain("NameError");
	expect(kernelPids()).not.toContain(pid);
}, 60_000);

test("choosing Wait keeps Python state once the interrupted Cell finishes", async () => {
	let release = "";
	const { prompts, ui } = withChoice(() => {
		writeFileSync(release, "");
		return "Wait and preserve state";
	});
	h = await createHarness({ ui });
	release = join(h.cwd, "release");
	await h.runCells("x = 41");
	await runAndAbort(h, stubbornCell(h.cwd), join(h.cwd, "started"));

	const [next] = await h.runCells("x + 1");
	expect(prompts).toHaveLength(1);
	expect(next?.isError).toBe(false);
	expect(resultText(next!)).toBe("42");
}, 60_000);

test("dismissing the wait/kill choice returns Kernel busy and keeps the Kernel", async () => {
	const { prompts, ui } = withChoice(() => undefined);
	h = await createHarness({ ui });
	await h.runCells("x = 41");
	await runAndAbort(h, stubbornCell(h.cwd), join(h.cwd, "started"));

	const [busy] = await h.runCells("x + 1");
	expect(prompts).toHaveLength(1);
	expect(busy?.isError).toBe(true);
	expect(resultText(busy!)).toContain("Kernel busy");

	writeFileSync(join(h.cwd, "release"), "");
	const [next] = await h.runCells("x + 1");
	expect(resultText(next!)).toBe("42");
}, 60_000);

test("without a UI, a busy Kernel returns a Kernel busy error instead of hanging", async () => {
	h = await createHarness();
	await h.runCells("x = 41");
	await runAndAbort(h, stubbornCell(h.cwd), join(h.cwd, "started"));

	const [busy] = await h.runCells("x + 1");
	expect(busy?.isError).toBe(true);
	expect(resultText(busy!)).toContain("Kernel busy");
}, 60_000);
