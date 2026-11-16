// Kernel bootstrap: creates and reuses the uv-managed venv that runs the Kernel runtime.
//
// Ported from Unharnessed's pre-Rust TypeScript host (commit 7d442aafa,
// packages/coding-agent/src/core/kernel/bootstrap.ts), adapted to pi's extension API.
// Copyright (c) 2026 Unharnessed
// Copyright (c) 2025-2026 Prime Intellect Ltd.
// Portions Copyright (c) 2025 Mario Zechner
// MIT License, see LICENSE.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PYTHON_VERSION = "3.13";

const MARKER_FILE = ".pi-ipython-bootstrap.json";
const LOCK_RETRY_MS = 200;
const UV_INSTALL_HINT = "curl -LsSf https://astral.sh/uv/install.sh | sh";

/** The vendored Kernel runtime (`runtime/` at the package root). */
export const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime");

export interface EnsureKernelPythonOptions {
	pythonVersion?: string;
	/** Venv directory. Defaults to `$PI_IPYTHON_VENV_DIR`, else `<agentDir>/pi-ipython/kernel-venv-<version>`. */
	venvDir?: string;
}

export function kernelVenvDir(pythonVersion: string): string {
	const override = process.env.PI_IPYTHON_VENV_DIR;
	if (override) return path.resolve(override);
	return path.join(getAgentDir(), "pi-ipython", `kernel-venv-${pythonVersion}`);
}

export function venvPython(venv: string): string {
	return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

const inFlight = new Map<string, Promise<string>>();

/** Return the venv's Python, building the venv first when it is missing or stale. */
export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const version = options.pythonVersion ?? DEFAULT_PYTHON_VERSION;
	const venv = options.venvDir ?? kernelVenvDir(version);
	const key = `${venv}\0${version}`;
	let promise = inFlight.get(key);
	if (!promise) {
		promise = ensureUncached(venv, version).finally(() => inFlight.delete(key));
		inFlight.set(key, promise);
	}
	return promise;
}

async function ensureUncached(venv: string, version: string): Promise<string> {
	const python = venvPython(venv);
	const identity = await runtimeIdentity(version);
	if (await isReady(venv, python, identity)) return python;

	const release = await acquireLock(venv);
	try {
		if (await isReady(venv, python, identity)) return python;
		await rm(venv, { recursive: true, force: true });
		const uv = await findUv();
		// uv sync installs the runtime and its locked dependencies into the venv,
		// downloading a managed Python when the requested version is missing.
		await run(uv, ["sync", "--project", RUNTIME_DIR, "--frozen", "--no-dev", "--no-editable", "--python", version], {
			UV_PROJECT_ENVIRONMENT: venv,
		});
		await writeFile(path.join(venv, MARKER_FILE), `${JSON.stringify({ identity })}\n`);
	} catch (error) {
		throw new Error(
			`Failed to set up the Python Kernel venv at ${venv}. First-time setup needs internet to fetch Python ${version} and the runtime's dependencies.\n${errorMessage(error)}`,
		);
	} finally {
		await release();
	}
	return python;
}

async function isReady(venv: string, python: string, identity: string): Promise<boolean> {
	try {
		await access(python, constants.X_OK);
		const marker = JSON.parse(await readFile(path.join(venv, MARKER_FILE), "utf8")) as { identity?: unknown };
		return marker.identity === identity;
	} catch {
		return false;
	}
}

/** Hash of the Python version plus the runtime sources, so any runtime change rebuilds the venv. */
async function runtimeIdentity(version: string): Promise<string> {
	const files = [path.join(RUNTIME_DIR, "pyproject.toml"), path.join(RUNTIME_DIR, "uv.lock")];
	const collect = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await collect(full);
			else if (entry.name.endsWith(".py")) files.push(full);
		}
	};
	await collect(path.join(RUNTIME_DIR, "src", "rlm"));
	files.sort();
	const hash = createHash("sha256").update(`python=${version}\0`);
	for (const file of files) {
		hash.update(path.relative(RUNTIME_DIR, file)).update("\0").update(await readFile(file)).update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/** Directory lock shared across pi processes. A lock whose owner pid is dead is taken over. */
async function acquireLock(venv: string): Promise<() => Promise<void>> {
	const lockDir = `${venv}.lock`;
	const pidFile = path.join(lockDir, "pid");
	await mkdir(path.dirname(lockDir), { recursive: true });
	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(pidFile, String(process.pid));
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = Number.parseInt(await readFile(pidFile, "utf8").catch(() => ""), 10);
		// A missing pid means the owner is between mkdir and writeFile; wait for it.
		if (Number.isSafeInteger(owner) && owner > 0 && !isProcessAlive(owner)) {
			await rm(lockDir, { recursive: true, force: true });
			continue;
		}
		await sleep(LOCK_RETRY_MS);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function findUv(): Promise<string> {
	const exe = process.platform === "win32" ? "uv.exe" : "uv";
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = path.join(dir, exe);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new Error(`uv is required to set up the Python Kernel. Install it: ${UV_INSTALL_HINT}`);
}

function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: { ...process.env, ...env },
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4096);
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}\n${stderr}`));
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
