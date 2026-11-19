import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { kernelVenvDir, venvPython } from "../src/kernel/bootstrap.ts";
import { DEFAULT_PACKAGE_REQUIREMENTS } from "../src/kernel/packages.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const INSTALL_HINT = "Install more with `await bash(f\"uv pip install --python {sys.executable} <pkg>\")`";

function writeConfigs(dirs: { cwd: string; agentDir: string }, global: unknown, project?: unknown): void {
	writeFileSync(join(dirs.agentDir, "pi-ipython.json"), JSON.stringify(global));
	if (project !== undefined) {
		mkdirSync(join(dirs.cwd, ".pi"), { recursive: true });
		writeFileSync(join(dirs.cwd, ".pi", "pi-ipython.json"), JSON.stringify(project));
	}
}

async function systemPrompt(harness: Harness): Promise<string> {
	let prompt = "";
	harness.setResponses([
		(context) => {
			prompt = getSystemMessageText(context.messages.find((m) => m.role === "system")!);
			return fauxAssistantMessage("hi");
		},
	]);
	await harness.session.prompt("hi");
	return prompt;
}

test("by default the Kernel has the default packages, pre-imports the common ones, and the prompt lists them", async () => {
	h = await createHarness();
	const [where, used, imported] = await h.runCells(
		"import sys\nsys.prefix",
		"(np.arange(3).sum().item(), pd.DataFrame({'a': [1]}).shape, requests.__name__, httpx.__name__, yaml.safe_load('a: 1'))",
		"import tomli, dotenv, scipy, bs4, lxml, pydantic, tyro\n'ok'",
	);
	expect(resultText(where!)).toBe(`'${kernelVenvDir("3.13", DEFAULT_PACKAGE_REQUIREMENTS)}'`);
	expect(resultText(used!)).toBe("(3, (1, 1), 'requests', 'httpx', {'a': 1})");
	expect(resultText(imported!)).toBe("'ok'");
	const prompt = await systemPrompt(h);
	expect(prompt).toContain("  - packages: np, pd, requests, httpx, yaml\n");
	expect(prompt).toContain(
		"- Installed Python packages: requests, httpx, yaml (PyYAML), tomli, dotenv (python-dotenv), pandas, numpy, scipy, "
			+ `bs4 (Beautiful Soup), lxml, pydantic, tyro. ${INSTALL_HINT}; packages you install last until the kernel environment is rebuilt.\n`,
	);
	expect(prompt).toContain("install into the kernel only packages you need in the REPL itself.");
});

test("python.packages from global and project config are installed in a venv of their own and listed", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(
			dirs,
			{ python: { defaultPackages: false, packages: ["six"] } },
			{ python: { packages: ["iniconfig", "six"] } },
		),
	});
	const [where, r] = await h.runCells("import sys\nsys.prefix", "import six, iniconfig\n'np' in globals()");
	expect(resultText(where!)).toBe(`'${kernelVenvDir("3.13", ["six", "iniconfig"])}'`);
	expect(resultText(r!)).toBe("False");
	const prompt = await systemPrompt(h);
	expect(prompt).toContain(`- Installed Python packages: six, iniconfig. ${INSTALL_HINT};`);
	expect(prompt).not.toContain("packages: np");
});

test("python.defaultPackages false runs the Kernel in the plain runtime venv, and the prompt still says how to install", async () => {
	h = await createHarness({ setup: (dirs) => writeConfigs(dirs, { python: { defaultPackages: false } }) });
	const [where, r] = await h.runCells(
		"import sys\nsys.prefix",
		"import importlib.util\n(importlib.util.find_spec('numpy') is None, 'np' in globals(), 'json' in globals())",
	);
	expect(resultText(where!)).toBe(`'${kernelVenvDir("3.13", [])}'`);
	expect(resultText(r!)).toBe("(True, False, True)");
	const prompt = await systemPrompt(h);
	expect(prompt).not.toContain("Installed Python packages");
	expect(prompt).toContain(`- Install Python packages with \`await bash(f"uv pip install --python {sys.executable} <pkg>")\``);
});

test("a Cell can install a package into the Kernel venv with uv", async () => {
	h = await createHarness({ setup: (dirs) => writeConfigs(dirs, { python: { defaultPackages: false, packages: ["iniconfig"] } }) });
	const [installed, uninstalled] = await h.runCells(
		"r = await bash(f'uv pip install --quiet --python {sys.executable} six')\nimport six\n(r.exit_code, six.__name__)",
		"(await bash(f'uv pip uninstall --quiet --python {sys.executable} six')).exit_code",
	);
	expect(resultText(installed!)).toBe("(0, 'six')");
	expect(resultText(uninstalled!)).toBe("0");
});

test("invalid python.packages entries are reported and skipped", async () => {
	const notices: string[] = [];
	let file = "";
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => {
			file = join(dirs.agentDir, "pi-ipython.json");
			writeConfigs(dirs, { python: { defaultPackages: false, packages: ["", "--index-url=http://x", 42, "six"], defaultPackages2: 1 } });
		},
	});
	const expected = "a uv requirement string, not empty and not starting with \"-\"";
	expect(notices).toEqual([
		`pi-ipython config: ${file}: "python.packages[0]" must be ${expected}, got ""`,
		`pi-ipython config: ${file}: "python.packages[1]" must be ${expected}, got "--index-url=http://x"`,
		`pi-ipython config: ${file}: "python.packages[2]" must be ${expected}, got 42`,
		`pi-ipython config: ${file}: unknown key "python.defaultPackages2"`,
	]);
	const [r] = await h.runCells("import sys, six\nsys.prefix");
	expect(resultText(r!)).toBe(`'${kernelVenvDir("3.13", ["six"])}'`);
});

test("python.packages that is not an array, and a non-boolean python.defaultPackages, are reported", async () => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => writeConfigs(dirs, { python: { packages: "six", defaultPackages: "no" } }),
	});
	expect(notices).toEqual([
		expect.stringContaining('"python.packages" must be an array of uv requirement strings, got "six"'),
		expect.stringContaining('"python.defaultPackages" must be true or false, got "no"'),
	]);
});

// A shell script stands in for the project venv's Python, running the plain runtime venv's.
test.skipIf(process.platform === "win32")("python.source project ignores Kernel packages with a warning and never pre-imports them", async () => {
	const notices: { message: string; type?: string }[] = [];
	h = await createHarness({
		ui: { notify: (message, type) => notices.push({ message, type }) },
		setup: (dirs) => {
			mkdirSync(join(dirs.cwd, ".venv", "bin"), { recursive: true });
			const python = venvPython(kernelVenvDir("3.13", DEFAULT_PACKAGE_REQUIREMENTS));
			writeFileSync(join(dirs.cwd, ".venv", "bin", "python"), `#!/bin/sh\nexec '${python}' "$@"\n`, { mode: 0o755 });
			writeConfigs(dirs, { python: { packages: ["six"] } }, { python: { source: "project" } });
		},
	});
	expect(notices).toEqual([{ message: 'pi-ipython config: "python.packages" is ignored because python.source is "project"', type: "error" }]);
	const [r] = await h.runCells("'np' in globals(), 'json' in globals()");
	expect(resultText(r!)).toBe("(False, True)");
	const prompt = await systemPrompt(h);
	expect(prompt).not.toContain("uv pip install");
	expect(prompt).not.toContain("packages: np");
	expect(notices).toHaveLength(1);
});

test("a configured package that fails to install fails the Kernel start and names python.packages", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { python: { defaultPackages: false, packages: ["pi-ipython-no-such-package-48"] } }),
	});
	const [r] = await h.runCells("1");
	expect(r!.isError).toBe(true);
	expect(resultText(r!)).toContain("pi-ipython-no-such-package-48");
	expect(resultText(r!)).toContain("python.packages");
}, 60_000);
