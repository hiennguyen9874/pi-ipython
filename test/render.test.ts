import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { initTheme, Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});
beforeAll(() => initTheme("dark"));

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]) => lines.map((l) => l.replace(ANSI, "").trimEnd()).join("\n");
const ui = { requestRender: () => {} } as unknown as TUI;

/** Draw a Cell's tool row the way interactive mode does, from the session's call and result. */
function renderRow(h: Harness, result: ToolResultMessage, { expanded = false, showImages = true } = {}): string[] {
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
	return row.render(100);
}

/** The theme pi is rendering with, to compare styled spans. */
const theme = () => (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] as Theme;

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

test("an image the terminal does not draw is shown as a placeholder", async () => {
	h = await createHarness();
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const [r] = await h.runCells(`from rlm.repl import emit\nemit({'image/png': '${png}'})\nprint('plotted')`);
	const text = plain(renderRow(h, r!, { showImages: false }));
	expect(text).toContain("plotted");
	expect(text).toMatch(/image\/png/i);
});
