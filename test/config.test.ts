import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createHarness, defaultKernelVenv, type Harness, resultText, systemPrompt, writeConfigs } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

test("README config defaults match a session without config files", async () => {
	h = await createHarness();
	const { config } = loadConfig(h.cwd, h.agentDir);
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const example = /^Defaults:\r?\n\s*```json\r?\n([\s\S]*?)\r?\n```/m.exec(readme);
	expect(example, "README defaults JSON block").not.toBeNull();
	expect(JSON.parse(example![1]!)).toEqual(config);

	const documented = Object.fromEntries([...readme.matchAll(/^\| (`[^|]+`) \| ([^|]+) \|/gm)]
		.flatMap(([, keys, defaults]) => keys!.split(" / ").map((key, i) => {
			const value = defaults!.split(" / ")[i]!.match(/^`([^\x60]+)`/)?.[1];
			return [key.slice(1, -1), value === undefined ? defaults : JSON.parse(value)];
		})));
	const expected = { "modelCalls.model": "unset", "modelCalls.classifier": "unset" };
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "object") {
			for (const [subkey, subvalue] of Object.entries(value)) {
				Object.assign(expected, { [`${key}.${subkey}`]: subvalue });
			}
		} else {
			Object.assign(expected, { [key]: value });
		}
	}
	expect(documented).toEqual(expected);
});

const managedVenv = defaultKernelVenv();
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

const NOTICE_RULE = "A `[bash-done …]` notice starts a later turn for it";

test("Background-command notices are on by default in TUI and RPC, so the prompt has the [bash-done …] rule", async () => {
	h = await createHarness({ mode: "rpc" });
	expect(await systemPrompt(h)).toContain(NOTICE_RULE);
	await h.dispose();
	h = await createHarness({ ui: {} });
	expect(await systemPrompt(h)).toContain(NOTICE_RULE);
});

test("Background-command notices stay off by default in print mode", async () => {
	h = await createHarness({ mode: "print" });
	expect(await systemPrompt(h)).not.toContain("bash-done");
});

test.each([
	["global", { backgroundNotices: false }, undefined],
	["project", { backgroundNotices: true }, { backgroundNotices: false }],
])("an explicit %s backgroundNotices false turns notices off", async (_where, global, project) => {
	h = await createHarness({ mode: "rpc", setup: (dirs) => writeConfigs(dirs, global, project) });
	expect(await systemPrompt(h)).not.toContain("bash-done");
});

test("python.source project runs the Kernel in the project's .venv, so its packages import", async () => {
	let venv = "";
	h = await createHarness({
		setup: ({ cwd }) => {
			venv = createProjectVenv(cwd);
			writeProjectConfig(cwd, { python: { source: "project" } });
		},
	});
	const [where, imported, mcpSdk] = await h.runCells(
		"import sys\nsys.prefix",
		"import projpkg\nprojpkg.VALUE",
		"import importlib.util\nimportlib.util.find_spec('mcp') is None",
	);
	expect(resultText(where!)).toBe(`'${venv}'`);
	expect(resultText(imported!)).toBe("'from project venv'");
	expect(resultText(mcpSdk!)).toBe("True");
});

test("an invalid parallelWorkPrompt is reported and the valid global value is retained", async () => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => writeConfigs(dirs, { parallelWorkPrompt: false }, { parallelWorkPrompt: "false" }),
	});
	expect(await systemPrompt(h)).not.toContain("Fan out commands");
	expect(notices).toEqual([expect.stringContaining('"parallelWorkPrompt" must be true or false')]);
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

test("inherited property names are reported as unknown keys without preventing Cells", async () => {
	const notices: string[] = [];
	let globalFile = "";
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: ({ agentDir }) => {
			globalFile = join(agentDir, "pi-ipython.json");
			writeGlobalConfig(agentDir, JSON.parse('{"constructor":true,"toString":true,"__proto__":true}'));
		},
	});
	expect(notices).toEqual(
		["constructor", "toString", "__proto__"].map((key) => `pi-ipython config: ${globalFile}: unknown key "${key}"`),
	);
	const [r] = await h.runCells(whereCell);
	expect(resultText(r!)).toBe(`('${managedVenv}', '3.13')`);
});

test.each(["2.7", "3.10", "3.10.9"])("unsupported Python %s is reported and defaults apply", async (version) => {
	const notices: string[] = [];
	let projectFile = "";
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: ({ cwd }) => {
			projectFile = join(cwd, ".pi", "pi-ipython.json");
			writeProjectConfig(cwd, { python: { version } });
		},
	});
	expect(notices).toEqual([
		`pi-ipython config: ${projectFile}: "python.version" must be a Python version >=3.11 like "3.13", got "${version}"`,
	]);
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

test("prelude.defaults false leaves the default names undefined and out of the prompt", async () => {
	h = await createHarness({ setup: (dirs) => writeConfigs(dirs, { prelude: { defaults: false } }) });
	const [r] = await h.runCells("'json' in globals(), 'Path' in globals()");
	expect(resultText(r!)).toBe("(False, False)");
	expect(await systemPrompt(h)).not.toContain("Pre-imported");
});

test("prelude.imports from global and project config concatenate, bind their names, and join the prompt", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(
			dirs,
			{ prelude: { imports: ["import base64 as b64", "from string import (ascii_lowercase as lower, digits,)"] } },
			{ prelude: { defaults: false, imports: ["import urllib.parse", "import base64 as b64"] } },
		),
	});
	const [r] = await h.runCells("b64.b64encode(b'hi'), lower[:3], digits[:3], urllib.parse.quote('a b'), 'json' in globals()");
	expect(resultText(r!)).toBe("(b'aGk=', 'abc', '012', 'a%20b', False)");
	const prompt = await systemPrompt(h);
	expect(prompt).toContain([
		"- Pre-imported in Cells only; files and scripts you write need their own imports:",
		"  - configured for this project, use them where they fit: `import base64 as b64`; `from string import (ascii_lowercase as lower, digits,)`; `import urllib.parse`",
		"",
	].join("\n"));
	expect(prompt).not.toContain("stdlib:");
});

test("with defaults on, configured imports get their own sub-line, without repeating a default statement", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { prelude: { imports: ["from pathlib import Path", "import numpy as np", "import base64 as b64"] } }),
	});
	const prompt = await systemPrompt(h);
	const section = prompt.slice(prompt.indexOf("- Pre-imported"), prompt.indexOf("- Other Kernel packages")).trimEnd().split("\n");
	expect(section).toEqual([
		"- Pre-imported in Cells only; files and scripts you write need their own imports:",
		"  - stdlib: json, os, re, sys, time, math, shutil, itertools, functools, collections, textwrap, Path, datetime (the class), timedelta, Counter, defaultdict",
		"  - packages: np, pd, requests, httpx, yaml",
		"  - configured for this project, use them where they fit: `import base64 as b64`",
	]);
});

test("invalid prelude.imports entries are reported and skipped; valid entries and defaults still apply", async () => {
	const notices: string[] = [];
	let file = "";
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => {
			file = join(dirs.agentDir, "pi-ipython.json");
			writeConfigs(dirs, { prelude: { imports: ["import os; os.remove('x')", "from os import *", 42, "from .x import y", "print(1)", "import base64"] } });
		},
	});
	const expected = 'one "import …" or "from … import …" statement (absolute, without "*")';
	expect(notices).toEqual([
		`pi-ipython config: ${file}: "prelude.imports[0]" must be ${expected}, got "import os; os.remove('x')"`,
		`pi-ipython config: ${file}: "prelude.imports[1]" must be ${expected}, got "from os import *"`,
		`pi-ipython config: ${file}: "prelude.imports[2]" must be ${expected}, got 42`,
		`pi-ipython config: ${file}: "prelude.imports[3]" must be ${expected}, got "from .x import y"`,
		`pi-ipython config: ${file}: "prelude.imports[4]" must be ${expected}, got "print(1)"`,
	]);
	const [r] = await h.runCells("base64.b64encode(b'hi'), json.dumps(1)");
	expect(resultText(r!)).toBe("(b'aGk=', '1')");
});

test("prelude.imports that is not an array is reported", async () => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => writeConfigs(dirs, { prelude: { imports: "import numpy" } }),
	});
	expect(notices).toEqual([expect.stringContaining('"prelude.imports" must be an array of import statements, got "import numpy"')]);
});

test("a prelude import that fails is reported to the user once per Kernel start; other prelude names still work", async () => {
	const notices: { message: string; type?: string }[] = [];
	h = await createHarness({
		ui: { notify: (message, type) => notices.push({ message, type }) },
		setup: (dirs) => writeConfigs(dirs, { prelude: { imports: ["import no_such_module_xyz as nope", "import base64"] } }),
	});
	const [r] = await h.runCells("base64.b64encode(b'hi'), json.dumps(1), 'nope' in globals()");
	expect(resultText(r!)).toBe("(b'aGk=', '1', False)");
	const [again] = await h.runCells("1");
	expect(resultText(again!)).toBe("1");
	expect(notices).toEqual([{
		message: "pi-ipython prelude: 'import no_such_module_xyz as nope' failed: ModuleNotFoundError: No module named 'no_such_module_xyz'",
		type: "warning",
	}]);
});

test("prelude.prompt false leaves the prelude out of the prompt, but the Kernel still imports it", async () => {
	h = await createHarness({
		setup: (dirs) => writeConfigs(dirs, { prelude: { prompt: false, imports: ["import base64 as b64"] } }),
	});
	expect(await systemPrompt(h)).not.toContain("Pre-imported");
	const [r] = await h.runCells("json.dumps(1), Path('a/b').name, b64.b64encode(b'hi')");
	expect(resultText(r!)).toBe("('1', 'b', b'aGk=')");
});

test("an invalid prelude.prompt is reported and the prelude line stays", async () => {
	const notices: string[] = [];
	h = await createHarness({
		ui: { notify: (m) => notices.push(m) },
		setup: (dirs) => writeConfigs(dirs, { prelude: { prompt: "no" } }),
	});
	expect(notices).toEqual([expect.stringContaining('"prelude.prompt" must be true or false, got "no"')]);
	expect(await systemPrompt(h)).toContain("Pre-imported in Cells only");
});
