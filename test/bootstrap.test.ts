import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const harnessUrl = new URL("./harness.ts", import.meta.url).href;

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
		const lock = `${venv}.lock`;
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
			expect(JSON.parse(await readFile(join(venv, ".pi-ipython-bootstrap.json"), "utf8")).identity)
				.toMatch(/^sha256:/);
			await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
