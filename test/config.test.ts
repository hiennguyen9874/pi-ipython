import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const managedVenv = process.env.PI_IPYTHON_VENV_DIR!;
const whereCell = "import sys\n(sys.prefix, '%d.%d' % sys.version_info[:2])";

function writeGlobalConfig(agentDir: string, config: unknown): void {
	writeFileSync(join(agentDir, "pi-ipython.json"), JSON.stringify(config));
}

function writeProjectConfig(cwd: string, config: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "pi-ipython.json"), typeof config === "string" ? config : JSON.stringify(config));
}

/** A project `.venv` with a module installed only there. */
function createProjectVenv(cwd: string): string {
	const venv = join(cwd, ".venv");
	execFileSync("uv", ["venv", "--quiet", "--python", "3.13", venv]);
	const python = join(venv, "bin", "python");
	const site = execFileSync(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
		encoding: "utf8",
	}).trim();
	writeFileSync(join(site, "projpkg.py"), "VALUE = 'from project venv'\n");
	return venv;
}

test("with no config files, the Kernel runs Python 3.13 in the managed uv venv and nothing is reported", async () => {
	const notices: string[] = [];
	h = await createHarness({ ui: { notify: (m) => notices.push(m) } });
	const [r] = await h.runCells(whereCell);
	expect(resultText(r!)).toBe(`('${managedVenv}', '3.13')`);
	expect(notices).toEqual([]);
});

test("python.source project runs the Kernel in the project's .venv, so its packages import", async () => {
	let venv = "";
	h = await createHarness({
		setup: ({ cwd }) => {
			venv = createProjectVenv(cwd);
			writeProjectConfig(cwd, { python: { source: "project" } });
		},
	});
	const [where, imported] = await h.runCells("import sys\nsys.prefix", "import projpkg\nprojpkg.VALUE");
	expect(resultText(where!)).toBe(`'${venv}'`);
	expect(resultText(imported!)).toBe("'from project venv'");
});

test("a project value overrides the global value for the same key", async () => {
	h = await createHarness({
		setup: ({ cwd, agentDir }) => {
			createProjectVenv(cwd);
			writeGlobalConfig(agentDir, { python: { source: "project" } });
			writeProjectConfig(cwd, { python: { source: "uv" } });
		},
	});
	const [r] = await h.runCells("import sys\nsys.prefix");
	expect(resultText(r!)).toBe(`'${managedVenv}'`);
});

test("global config applies when the project does not set the key", async () => {
	let venv = "";
	h = await createHarness({
		setup: ({ cwd, agentDir }) => {
			venv = createProjectVenv(cwd);
			writeGlobalConfig(agentDir, { python: { source: "project" } });
			writeProjectConfig(cwd, { confirmEachCell: false });
		},
	});
	const [r] = await h.runCells("import sys\nsys.prefix");
	expect(resultText(r!)).toBe(`'${venv}'`);
});

test("an invalid value is reported with the file and key, and the session starts with the defaults", async () => {
	const notices: { message: string; type?: string }[] = [];
	let projectFile = "";
	h = await createHarness({
		ui: { notify: (message, type) => notices.push({ message, type }) },
		setup: ({ cwd }) => {
			projectFile = join(cwd, ".pi", "pi-ipython.json");
			writeProjectConfig(cwd, { python: { source: "conda", version: 3.13 } });
		},
	});
	expect(notices).toHaveLength(2);
	expect(notices.every((n) => n.type === "error" && n.message.includes(projectFile))).toBe(true);
	expect(notices[0]!.message).toContain('"python.source"');
	expect(notices[1]!.message).toContain('"python.version"');

	const [r] = await h.runCells(whereCell);
	expect(resultText(r!)).toBe(`('${managedVenv}', '3.13')`);
});

test("unparseable JSON and unknown keys are reported with the file", async () => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: ({ cwd, agentDir }) => {
			writeGlobalConfig(agentDir, { pyhton: {} });
			writeProjectConfig(cwd, "{ not json");
		},
	});
	expect(notices).toEqual([
		expect.stringMatching(/agent[/\\]pi-ipython\.json: unknown key "pyhton"/),
		expect.stringMatching(/\.pi[/\\]pi-ipython\.json: invalid JSON/),
	]);
	const [r] = await h.runCells("1 + 1");
	expect(resultText(r!)).toBe("2");
});
