import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { IpythonToolDetails } from "../src/tool/ipython-tool.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});
beforeAll(() => initTheme("dark"));

interface Update {
	content: { type: string; text?: string }[];
	details?: IpythonToolDetails;
}

/** Record the partial updates of ipython tool calls, and the order of updates and ends. */
function recordUpdates(h: Harness) {
	const updates: Update[] = [];
	const events: ("update" | "end")[] = [];
	h.session.subscribe((event) => {
		if (event.type === "tool_execution_update" && event.toolName === "ipython") {
			updates.push(event.partialResult as Update);
			events.push("update");
		} else if (event.type === "tool_execution_end" && event.toolName === "ipython") {
			events.push("end");
		}
	});
	return { updates, events };
}

const text = (u: Update) => u.content.map((b) => b.text ?? "").join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a running Cell streams its growing output tail, and nothing after its result", async () => {
	h = await createHarness();
	const { updates, events } = recordUpdates(h);
	const [r] = await h.runCells("import time\nprint('first', flush=True)\ntime.sleep(0.6)\nprint('second', flush=True)\ntime.sleep(0.4)");
	await sleep(300);
	expect(r!.isError).toBe(false);

	// The first update marks the start, before any output.
	expect(updates[0]).toEqual({ content: [], details: expect.objectContaining({ stdout: "", stderr: "", backgroundOutput: "", running: true }) });
	const live = updates.filter((u) => u.details?.stdout);
	expect(updates.every((u) => u.details!.running)).toBe(true);
	const early = live.findIndex((u) => u.details!.stdout.includes("first") && !u.details!.stdout.includes("second"));
	const late = live.findIndex((u) => u.details!.stdout.includes("first\nsecond"));
	expect(early).toBeGreaterThanOrEqual(0);
	expect(late).toBeGreaterThan(early);
	expect(text(live[late]!)).toBe("first\nsecond");
	expect(events.at(-1)).toBe("end");
	expect(events.filter((e) => e === "end")).toHaveLength(1);
	// The final result is unchanged by streaming.
	expect(r!.details).not.toHaveProperty("running");
});

test("partial updates of a huge Cell stay within the output limits", async () => {
	h = await createHarness();
	const { updates } = recordUpdates(h);
	const [r] = await h.runCells("import sys, time\nfor i in range(100_000): sys.stdout.write(f'{i:06d}' + 'x' * 93 + '\\n')\nsys.stdout.flush()\ntime.sleep(0.5)");
	expect(r!.isError).toBe(false);
	const live = updates.filter((u) => u.details);
	expect(live.length).toBeGreaterThan(0);
	for (const u of live) {
		for (const stream of [u.details!.stdout, u.details!.stderr, u.details!.backgroundOutput]) {
			expect(Buffer.byteLength(stream)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(stream.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES + 1);
		}
		// The joined tail plus its notice, never a whole stream.
		expect(Buffer.byteLength(text(u))).toBeLessThan(DEFAULT_MAX_BYTES + 200);
	}
	const last = live.at(-1)!;
	expect(last.details!.stdout).toContain(`099999${"x".repeat(93)}`);
	expect(text(last)).toMatch(/\[Output truncated \(\d+\.\dMB so far\): showing the last \d+ of 100000 lines\]$/);
	expect(text(last)).not.toContain("Full output");
});

test("Background output arriving while a Cell runs streams with it", async () => {
	h = await createHarness();
	const { updates } = recordUpdates(h);
	const [r] = await h.runCells("import threading, time\nthreading.Thread(target=lambda: print('tick', flush=True)).start()\ntime.sleep(0.6)\nprint('own')");
	expect(r!.isError).toBe(false);
	const live = updates.filter((u) => u.details?.backgroundOutput.includes("tick"));
	expect(live.length).toBeGreaterThan(0);
	expect(text(live[0]!)).toContain("[background output]\ntick");
});

test("a partial result shows the output tail and the running time", async () => {
	h = await createHarness();
	const row = new ToolExecutionComponent(
		"ipython", "call-1", { code: "print('hi')" }, { showImages: true }, h.session.getToolDefinition("ipython"),
		{ requestRender: () => {} } as unknown as TUI, h.cwd,
	);
	row.markExecutionStarted();
	row.setArgsComplete();
	const plain = () => row.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).join("\n");

	row.updateResult({ content: [], details: undefined, isError: false }, true);
	expect(plain()).toMatch(/Running… \d+\.\ds/);

	const details: IpythonToolDetails = {
		stdout: "one\ntwo\n", stderr: "careful\n", backgroundOutput: "tick\n", images: [], status: "ok", durationMs: 0, running: true,
	};
	row.updateResult({ content: [{ type: "text", text: "one\ntwo" }], details, isError: false }, true);
	const shown = plain();
	expect(shown).toContain("two\ncareful\n[background output]\ntick");
	expect(shown).toMatch(/Running… \d+\.\ds/);

	row.updateResult({ content: [{ type: "text", text: "one\ntwo" }], details: { ...details, running: undefined }, isError: false });
	expect(plain()).not.toContain("Running");
});
