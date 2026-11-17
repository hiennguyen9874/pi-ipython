import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { initTheme, Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	await h?.dispose();
	h = undefined;
});
beforeAll(() => initTheme("dark"));

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]) => lines.map((l) => l.replace(ANSI, "").trimEnd()).join("\n");
const ui = { requestRender: () => {} } as unknown as TUI;

/** Draw a Cell's tool row the way interactive mode does, from the session's call and result. */
function renderRow(h: Harness, result: ToolResultMessage, { expanded = false, showImages = true, width = 100 } = {}): string[] {
	const call = h.session.messages
		.flatMap((m) => (m.role === "assistant" ? m.content : []))
		.find((b) => b.type === "toolCall" && b.id === result.toolCallId);
	if (call?.type !== "toolCall") throw new Error("tool call not found");
	const row = new ToolExecutionComponent(
		call.name, call.id, call.arguments, { showImages }, h.session.getToolDefinition("ipython"), ui, h.cwd,
	);
	row.setExpanded(expanded);
	row.markExecutionStarted();
	row.setArgsComplete();
	row.updateResult({ content: result.content, details: result.details, isError: result.isError });
	return row.render(width);
}

/** The theme pi is rendering with, to compare styled spans. */
const theme = () => (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] as Theme;

test("collapsed output fits narrow terminals", async () => {
	h = await createHarness();
	const [r] = await h.runCells("for i in range(100): print(i)");
	for (const width of [100, 30, 15]) {
		const lines = renderRow(h, r!, { width });
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(plain(lines)).toContain("99");
	}
});

test.each([undefined, { maxBytes: 100000, maxLines: 3000 }])(
	"expanded output is limited before styling with config %j",
	async (output) => {
		h = await createHarness({
			setup: ({ cwd }) => {
				if (!output) return;
				mkdirSync(join(cwd, ".pi"));
				writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output }));
			},
		});
		const count = output ? 2200 : 1000;
		const [r] = await h.runCells(`for i in range(${count}): print(f'{i:04d}' + 'x' * 36)`);
		const expanded = plain(renderRow(h, r!, { expanded: true }));
		expect(expanded).toContain("0000" + "x".repeat(36));
		expect(expanded).toContain(String(count - 1).padStart(4, "0") + "x".repeat(36));
		expect(expanded).not.toContain("Output truncated");
	},
);

test("expanded mixed output keeps its tail, colours, and spill path at configured limits", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ output: { maxLines: 4 } }));
		},
	});
	const [r] = await h.runCells("import sys\nfor i in range(12): print(f'line {i}')\nprint('warning-text', file=sys.stderr)\n'done'");
	const lines = renderRow(h, r!, { expanded: true });
	const text = plain(lines);
	expect(text).not.toContain("line 0");
	expect(text).toContain("line 11");
	expect(text).toContain("warning-text");
	expect(text).toContain("'done'");
	expect(lines.join("\n")).toContain(theme().fg("warning", "warning-text"));
	const path = (r!.details as { fullOutputPath: string }).fullOutputPath;
	expect(text.replace(/\s+/g, " ")).toContain(path);
	expect(readFileSync(path, "utf8")).toContain("line 0");
});

test("a large exception stays compact and its full message is saved", async () => {
	h = await createHarness();
	const [r] = await h.runCells("raise ValueError('start-' + 'x' * 100000 + '-end')");
	const collapsed = renderRow(h, r!);
	expect(collapsed.length).toBeLessThan(30);
	expect(plain(collapsed)).toContain("ValueError");
	expect(plain(collapsed)).toContain("to expand");
	const expanded = plain(renderRow(h, r!, { expanded: true }));
	expect(expanded).toContain("-end");
	expect(expanded).toContain("Output truncated");
	const path = (r!.details as { fullOutputPath: string }).fullOutputPath;
	expect(readFileSync(path, "utf8")).toContain("start-" + "x".repeat(100000) + "-end");
});

test("a failed output spill remains visible in collapsed and expanded rows", async () => {
	h = await createHarness();
	await h.runCells("1");
	for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, join(h.cwd, "missing"));
	const [r] = await h.runCells("print('kept\\n' * 2100, end='')");
	for (const expanded of [false, true]) {
		expect(plain(renderRow(h, r!, { expanded })).replace(/\s+/g, " ")).toContain("Full output could not be saved");
	}
});

test("a Cell call shows its Python code highlighted", async () => {
	h = await createHarness();
	const code = "def double(x):\n    return x * 2\n\ndouble(21)";
	const [r] = await h.runCells(code);
	const lines = renderRow(h, r!);
	const text = plain(lines);
	expect(text).toContain("ipython");
	expect(text).toContain("def double(x):");
	expect(text).toContain("    return x * 2");
	// Python keywords get the theme's keyword colour.
	expect(lines.join("\n")).toContain(theme().fg("syntaxKeyword", "def"));
	expect(text).toContain("42");
});

test("a long result is collapsed to its tail, and expanding shows all of it", async () => {
	h = await createHarness();
	const [r] = await h.runCells("for i in range(100):\n    print(f'line {i}')");
	const collapsed = plain(renderRow(h, r!));
	expect(collapsed).toContain("line 99");
	expect(collapsed).not.toContain("line 0\n");
	expect(collapsed).toMatch(/earlier lines/);
	const expanded = plain(renderRow(h, r!, { expanded: true }));
	expect(expanded).toContain("line 0\n");
	expect(expanded).toContain("line 99");
	expect(expanded).not.toMatch(/earlier lines/);
});

test("a long Cell is collapsed to its first lines, and expanding shows all of it", async () => {
	h = await createHarness();
	const code = Array.from({ length: 40 }, (_, i) => `v${i} = ${i}`).join("\n");
	const [r] = await h.runCells(code);
	const collapsed = plain(renderRow(h, r!));
	expect(collapsed).toContain("v0 = 0");
	expect(collapsed).not.toContain("v39 = 39");
	expect(collapsed).toMatch(/more lines/);
	expect(plain(renderRow(h, r!, { expanded: true }))).toContain("v39 = 39");
});

test("an error result shows the exception name and message; the traceback only when expanded", async () => {
	h = await createHarness();
	const [r] = await h.runCells("def boom():\n    return 1 / 0\n\nprint('before')\nboom()");
	const lines = renderRow(h, r!);
	const collapsed = plain(lines);
	expect(collapsed).toContain("before");
	expect(collapsed).toContain("ZeroDivisionError: division by zero");
	expect(collapsed.match(/ZeroDivisionError/g)).toHaveLength(1);
	// The exception name is bold, in the theme's error colour.
	const [errorColour] = theme().fg("error", "|").split("|");
	expect(lines.join("\n")).toContain(`${errorColour}${theme().bold("ZeroDivisionError")}`);
	expect(collapsed).not.toContain("Traceback");
	const expanded = plain(renderRow(h, r!, { expanded: true }));
	expect(expanded).toContain("Traceback");
	expect(expanded.match(/ZeroDivisionError: division by zero/g)).toHaveLength(1);
});

test("a Cell refused before running shows the reason as an error", async () => {
	h = await createHarness({
		setup: ({ cwd }) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "pi-ipython.json"), JSON.stringify({ confirmEachCell: true }));
		},
	});
	const [r] = await h.runCells("1");
	expect(plain(renderRow(h, r!))).toContain("there is no UI to ask the user for approval");
});

test("a Cell whose Kernel died shows the replacement warning and the exit reason", async () => {
	h = await createHarness();
	const [r] = await h.runCells("import os; os._exit(17)");
	const text = plain(renderRow(h, r!)).replace(/\s+/g, " ");
	expect(text).toContain("Kernel replaced: earlier Python state is gone.");
	expect(text).toContain("Kernel exited (exit code 17)");
});

test("an image the terminal does not draw is shown as a placeholder", async () => {
	h = await createHarness();
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const [r] = await h.runCells(`from rlm.repl import emit\nemit({'image/png': '${png}'})\nprint('plotted')`);
	const text = plain(renderRow(h, r!, { showImages: false }));
	expect(text).toContain("plotted");
	expect(text).toMatch(/image\/png/i);
});
