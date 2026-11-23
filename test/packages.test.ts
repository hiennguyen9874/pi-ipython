import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { kernelVenvDir, venvPython } from "../src/kernel/bootstrap.ts";
import { createHarness, defaultKernelVenv, type Harness, resultText, systemPrompt, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const INSTALL_CODE = "import shlex, sys; r = await bash(f\"uv pip install --python {shlex.quote(sys.executable)} package-name\")";
const INSTALL_HINT = `Add one with \`${INSTALL_CODE}\`, then check \`r.exit_code\`.`;

test("by default the Kernel has the default packages, pre-imports the common ones, and the prompt lists them", async () => {
	h = await createHarness();
	const [where, used, imported] = await h.runCells(
		"import sys\nassert not any(name == 'PIL' or name.startswith('PIL.') for name in sys.modules)\nsys.prefix",
		"(np.arange(3).sum().item(), pd.DataFrame({'a': [1]}).shape, requests.__name__, httpx.__name__, yaml.safe_load('a: 1'))",
		"import tomli, dotenv, scipy, bs4, lxml, pydantic, tyro\nfrom PIL import Image\n'ok'",
	);
	expect(resultText(where!)).toBe(`'${defaultKernelVenv()}'`);
	expect(resultText(used!)).toBe("(3, (1, 1), 'requests', 'httpx', {'a': 1})");
	expect(resultText(imported!)).toBe("'ok'");
	const prompt = await systemPrompt(h);
	expect(prompt).toContain("  - packages: np, pd, requests, httpx, yaml\n");
	expect(prompt).toContain(
		"- Other Kernel packages: tomli, dotenv (python-dotenv), scipy, bs4 (Beautiful Soup), lxml, pydantic, tyro, PIL (Pillow). "
			+ `${INSTALL_HINT}\n`,
	);
	expect(prompt).toContain("Kernel packages serve Cells only.");
});

test("global and trusted project packages merge; skipped markers and raw URLs stay out of the prompt", async () => {
	const skipped = "never-installed @ https://demo:sample-token@example.invalid/pkg.zip ; python_version < '3'";
	h = await createHarness({
		projectTrusted: true,
		setup: (dirs) => writeConfigs(
			dirs,
			{ python: { defaultPackages: false, packages: ["six"] } },
			{ python: { packages: ["iniconfig", "six", skipped] } },
		),
	});
	const [where, r] = await h.runCells("import sys\nsys.prefix", "import six, iniconfig\n'np' in globals()");
	expect(resultText(where!)).toBe(`'${kernelVenvDir("3.13", ["six", "iniconfig", skipped])}'`);
	expect(resultText(r!)).toBe("False");
	const prompt = await systemPrompt(h);
	expect(prompt).toContain(`- Installed Kernel packages: iniconfig, six. ${INSTALL_HINT}`);
	expect(prompt).not.toContain("packages: np");
	expect(prompt).not.toContain("never-installed");
	expect(prompt).not.toContain("sample-token");
});

test("untrusted project requirements are ignored before the prompt or first Cell", async () => {
	const notices: string[] = [];
	h = await createHarness({
		projectTrusted: false,
		ui: { notify: (message) => notices.push(message) },
		setup: (dirs) => writeConfigs(dirs,
			{ python: { defaultPackages: false, packages: ["six"] } },
			{ python: { packages: ["iniconfig"] } },
		),
	});
	expect(notices).toEqual(['pi-ipython config: Project "python.packages" is ignored because the project is not trusted']);
	const prompt = await systemPrompt(h);
	expect(prompt).toContain("Installed Kernel packages: six.");
	expect(prompt).not.toContain("iniconfig");
	const [r] = await h.runCells("import importlib.util, six\nimportlib.util.find_spec('iniconfig') is None");
	expect(resultText(r!)).toBe("True");
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
	expect(prompt).not.toContain("Installed Kernel packages");
	expect(prompt).toContain(`- Add a Kernel package with \`${INSTALL_CODE}\`, then check \`r.exit_code\`.`);
});

test("the prompt's uv command works without a prelude and with a space in the venv path", async () => {
	const previous = process.env.PI_IPYTHON_VENV_DIR;
	try {
		h = await createHarness({
			setup: (dirs) => {
				process.env.PI_IPYTHON_VENV_DIR = join(dirs.agentDir, "kernel venv");
				writeConfigs(dirs, { python: { defaultPackages: false }, prelude: { defaults: false } });
			},
		});
		expect(await systemPrompt(h)).toContain(INSTALL_CODE);
		const [prelude, installed] = await h.runCells(
			"'sys' in globals()",
			`${INSTALL_CODE.replace("package-name", "six")}\nimport six\nsix.__name__`,
		);
		expect(resultText(prelude!)).toBe("False");
		expect(resultText(installed!)).toBe("'six'");
	} finally {
		await h?.dispose();
		h = undefined;
		if (previous === undefined) delete process.env.PI_IPYTHON_VENV_DIR;
		else process.env.PI_IPYTHON_VENV_DIR = previous;
	}
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
		`pi-ipython config: ${file}: "python.packages[1]" must be ${expected}, got "--index-url=[redacted URL]"`,
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
			const python = venvPython(defaultKernelVenv());
			writeFileSync(join(dirs.cwd, ".venv", "bin", "python"), `#!/bin/sh\nexec '${python}' "$@"\n`, { mode: 0o755 });
			writeConfigs(dirs, { python: { packages: [] } }, { python: { source: "project" } });
		},
	});
	expect(notices).toEqual([{ message: 'pi-ipython config: "python.packages" is ignored because python.source is "project"', type: "warning" }]);
	const [r] = await h.runCells("'np' in globals(), 'json' in globals()");
	expect(resultText(r!)).toBe("(False, True)");
	const prompt = await systemPrompt(h);
	expect(prompt).not.toContain("uv pip install");
	expect(prompt).not.toContain("packages: np");
	expect(notices).toHaveLength(1);
});

test("an incompatible Kernel package leaves the venv unready", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { python: { defaultPackages: false, packages: ["mcp<2"] } }),
	});
	const [r] = await h.runCells("1");
	expect(r!.isError).toBe(true);
	expect(resultText(r!)).toMatch(/pi-ipython-runtime.*mcp/s);
	expect(resultText(r!)).toContain("python.packages");
}, 60_000);

test("a configured package that fails to install fails the Kernel start and names python.packages", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { python: { defaultPackages: false, packages: ["pi-ipython-no-such-package-48"] } }),
	});
	const [r] = await h.runCells("1");
	expect(r!.isError).toBe(true);
	expect(resultText(r!)).toContain("pi-ipython-no-such-package-48");
	expect(resultText(r!)).toContain("python.packages");
}, 60_000);
