import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { kernelVenvDir } from "../src/kernel/bootstrap.ts";
import { defaultKernelVenv } from "./harness.ts";

const exec = promisify(execFile);
const harnessUrl = new URL("./harness.ts", import.meta.url).href;

test("venv paths isolate versions and distinct package sets, regardless of entry order", () => {
	expect(kernelVenvDir("3.13", ["six", "iniconfig"])).toBe(kernelVenvDir("3.13", ["iniconfig", "six", "six"]));
	expect(kernelVenvDir("3.13", ["six", "iniconfig"])).not.toBe(kernelVenvDir("3.13", ["iniconfig\nsix"]));
	expect(kernelVenvDir("3.13", ["six"])).not.toBe(kernelVenvDir("3.12", ["six"]));
	expect(kernelVenvDir("3.13")).not.toBe(kernelVenvDir("3.12"));
});

// Separate pi hosts are necessary: bootstrap deduplicates callers within one process.
const runSession = `
import { createHarness, resultText } from ${JSON.stringify(harnessUrl)};
const h = await createHarness();
try {
	const [r] = await h.runCells("40 + 2");
	if (r.isError || resultText(r) !== "42") throw new Error(JSON.stringify(r));
} finally {
	await h.dispose();
}
`;

test.each(["ownerless directory", "dead-owner directory", "dead-owner file"])(
	"concurrent sessions recover a stale %s bootstrap lock",
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipython-lock-"));
		const venv = join(root, "venv");
		// The child processes use this prefix, the default version, and the default package set.
		const previous = process.env.PI_IPYTHON_VENV_DIR;
		process.env.PI_IPYTHON_VENV_DIR = venv;
		const venvDir = defaultKernelVenv();
		process.env.PI_IPYTHON_VENV_DIR = previous;
		const lock = `${venvDir}.lock`;
		try {
			if (kind === "dead-owner file") {
				await writeFile(lock, "2147483647\n");
			} else {
				await mkdir(lock);
				if (kind === "dead-owner directory") await writeFile(join(lock, "pid"), "2147483647\n");
			}
			const old = new Date(Date.now() - 60_000);
			await utimes(lock, old, old);

			const results = await Promise.allSettled(
				Array.from({ length: 4 }, () => exec(process.execPath,
					["--experimental-transform-types", "--input-type=module", "-e", runSession],
					{ env: { ...process.env, PI_IPYTHON_VENV_DIR: venv }, timeout: 25_000 },
				)),
			);
			for (const result of results) expect(result.status, JSON.stringify(result)).toBe("fulfilled");
			expect(JSON.parse(await readFile(join(venvDir, ".pi-ipython-bootstrap.json"), "utf8")).identity)
				.toMatch(/^sha256:/);
			await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
