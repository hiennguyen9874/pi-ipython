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
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { tryAcquireDirLock } from "./dir-lock.ts";
import { isProcessAlive } from "./process.ts";

export const DEFAULT_PYTHON_VERSION = "3.13";

const MARKER_FILE = ".pi-ipython-bootstrap.json";
const LOCK_RETRY_MS = 200;
const OWNERLESS_LOCK_STALE_MS = 30_000;
const UV_INSTALL_HINT = "curl -LsSf https://astral.sh/uv/install.sh | sh";

/** The vendored Kernel runtime (`runtime/` at the package root). */
export const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime");

export interface EnsureKernelPythonOptions {
	pythonVersion?: string;
	/** Kernel packages (uv requirements) installed after the runtime. */
	packages?: readonly string[];
	/** Venv directory. Defaults to `kernelVenvDir(pythonVersion, packages)`. */
	venvDir?: string;
}

/**
 * `$PI_IPYTHON_VENV_DIR`, else `<agentDir>/pi-ipython/kernel-venv-<version>`, suffixed with a hash of the
 * package set when it is not empty: each package set gets its own venv, so sessions with different sets
 * never rebuild each other's (ADR 0004).
 */
export function kernelVenvDir(pythonVersion: string, packages: readonly string[] = []): string {
	const override = process.env.PI_IPYTHON_VENV_DIR;
	const base = override ? path.resolve(override) : path.join(getAgentDir(), "pi-ipython", `kernel-venv-${pythonVersion}`);
	const set = packageSet(packages);
	return set.length === 0 ? base : `${base}-${createHash("sha256").update(set.join("\n")).digest("hex").slice(0, 8)}`;
}

/** Sorted and deduplicated, so order and repeats in config do not change the venv. */
function packageSet(packages: readonly string[]): string[] {
	return [...new Set(packages.map((p) => p.trim()))].sort();
}

/** `PATH` plus the directories uv is looked up in, so `bash("uv …")` in a Cell finds the uv that built the venv. */
export function kernelPathEnv(): Record<string, string> {
	const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const dirs = (process.env[key] ?? "").split(path.delimiter).filter(Boolean);
	const uvDir = path.join(os.homedir(), ".local", "bin");
	return { [key]: [...dirs, ...(dirs.includes(uvDir) ? [] : [uvDir])].join(path.delimiter) };
}

export function venvPython(venv: string): string {
	return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

/** Source dir of the vendored runtime, put on PYTHONPATH when the Kernel runs in a project venv. */
export const RUNTIME_SRC_DIR = path.join(RUNTIME_DIR, "src");

/** The project's own `.venv` Python (`python.source: project`). The runtime is not installed there. */
export async function resolveProjectPython(cwd: string): Promise<string> {
	const python = venvPython(path.join(cwd, ".venv"));
	try {
		await access(python, constants.X_OK);
	} catch {
		throw new Error(
			`python.source is "project" but no Python was found at ${python}. Create the project venv (for example \`uv venv\`) or set python.source to "uv".`,
		);
	}
	return python;
}

const inFlight = new Map<string, Promise<string>>();

/** Return the venv's Python, building the venv first when it is missing or stale. */
export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const version = options.pythonVersion ?? DEFAULT_PYTHON_VERSION;
	const packages = packageSet(options.packages ?? []);
	const venv = options.venvDir ?? kernelVenvDir(version, packages);
	const key = `${venv}\0${version}\0${packages.join("\n")}`;
	let promise = inFlight.get(key);
	if (!promise) {
		promise = ensureUncached(venv, version, packages).finally(() => inFlight.delete(key));
		inFlight.set(key, promise);
	}
	return promise;
}

async function ensureUncached(venv: string, version: string, packages: string[]): Promise<string> {
	const python = venvPython(venv);
	const identity = await runtimeIdentity(version, packages);
	if (await isReady(venv, python, identity)) return python;

	const release = await acquireLock(venv);
	try {
		if (await isReady(venv, python, identity)) return python;
		await rm(venv, { recursive: true, force: true });
		const uv = await findUv();
		// Refresh the local runtime wheel: uv's cache may otherwise reuse a wheel
		// built from older sources even after runtimeIdentity requires a rebuild.
		await run(uv, ["sync", "--project", RUNTIME_DIR, "--frozen", "--no-dev", "--no-editable", "--refresh-package", "pi-ipython-runtime", "--python", version], {
			UV_PROJECT_ENVIRONMENT: venv,
		});
		if (packages.length > 0) {
			try {
				await run(uv, ["pip", "install", "--python", python, ...packages], {});
			} catch (error) {
				throw new Error(`Installing the Kernel packages failed; check python.packages in pi-ipython.json.\n${errorMessage(error)}`);
			}
		}
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

/** Hash of the Python version, the Kernel packages, and the runtime sources, so any change rebuilds the venv. */
async function runtimeIdentity(version: string, packages: readonly string[]): Promise<string> {
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
	const hash = createHash("sha256").update(`python=${version}\0packages=${packages.join("\n")}\0`);
	for (const file of files) {
		hash.update(path.relative(RUNTIME_DIR, file)).update("\0").update(await readFile(file)).update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/** Atomically published lock shared across pi processes, including recovery of legacy directory locks. */
async function acquireLock(venv: string): Promise<() => Promise<void>> {
	const lockPath = `${venv}.lock`;
	await mkdir(path.dirname(lockPath), { recursive: true });
	for (;;) {
		const attempt = await tryAcquireDirLock(lockPath, async (ownerPid) => {
			if (ownerPid !== undefined) return isProcessAlive(ownerPid);
			try {
				const info = await stat(lockPath);
				return Date.now() - info.mtimeMs <= OWNERLESS_LOCK_STALE_MS;
			} catch {
				// An unjudgeable lock may still be live.
				return true;
			}
		});
		if (attempt === "acquired") return () => rm(lockPath, { recursive: true, force: true });
		if (attempt === "held") await sleep(LOCK_RETRY_MS);
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
