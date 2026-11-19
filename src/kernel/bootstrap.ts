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
import { installedPackageLabels, redactPackageUrls } from "./packages.ts";
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
}

/** The override replaces the prefix, not the version or package-set key (ADR 0004). */
export function kernelVenvDir(pythonVersion: string, packages: readonly string[] = []): string {
	const override = process.env.PI_IPYTHON_VENV_DIR;
	const prefix = override ? path.resolve(override) : path.join(getAgentDir(), "pi-ipython", "kernel-venv");
	const set = packageSet(packages);
	const base = `${prefix}-${pythonVersion}`;
	return set.length === 0 ? base : `${base}-${createHash("sha256").update(JSON.stringify(set)).digest("hex")}`;
}

/** Sorted and deduplicated, so order and repeats in config do not change the venv. */
function packageSet(packages: readonly string[]): string[] {
	return [...new Set(packages.map((p) => p.trim()))].sort();
}

const pathKey = () => process.platform === "win32"
	? Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path"
	: "PATH";

function uvSearchDirs(): string[] {
	const dirs = (process.env[pathKey()] ?? "").split(path.delimiter).filter(Boolean);
	return [...new Set([...dirs, path.join(os.homedir(), ".local", "bin")])];
}

/** Let `bash("uv …")` see the same search directories as bootstrap. */
export function kernelPathEnv(): Record<string, string> {
	return { [pathKey()]: uvSearchDirs().join(path.delimiter) };
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

interface KernelEnvironment {
	python: string;
	packageLabels: string[];
}

const inFlight = new Map<string, Promise<KernelEnvironment>>();

/** Return the venv's Python and labels, building the venv first when it is missing or stale. */
export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<KernelEnvironment> {
	const version = options.pythonVersion ?? DEFAULT_PYTHON_VERSION;
	const packages = packageSet(options.packages ?? []);
	const venv = kernelVenvDir(version, packages);
	let promise = inFlight.get(venv);
	if (!promise) {
		promise = ensureUncached(venv, version, packages).finally(() => inFlight.delete(venv));
		inFlight.set(venv, promise);
	}
	return promise;
}

async function ensureUncached(venv: string, version: string, packages: string[]): Promise<KernelEnvironment> {
	const python = venvPython(venv);
	const identity = await runtimeIdentity(version, packages);
	const ready = await readReadyLabels(venv, python, identity);
	if (ready) return { python, packageLabels: ready };

	const release = await acquireLock(venv);
	try {
		const ready = await readReadyLabels(venv, python, identity);
		if (ready) return { python, packageLabels: ready };
		await rm(venv, { recursive: true, force: true });
		const uv = await findUv();
		// Refresh the local runtime wheel: uv's cache may otherwise reuse a wheel
		// built from older sources even after runtimeIdentity requires a rebuild.
		await run(uv, ["sync", "--project", RUNTIME_DIR, "--frozen", "--no-dev", "--no-editable", "--refresh-package", "pi-ipython-runtime", "--python", version], {
			UV_PROJECT_ENVIRONMENT: venv,
		});
		let packageLabels: string[] = [];
		if (packages.length > 0) {
			try {
				await run(uv, ["pip", "install", "--python", python, ...packages]);
				await run(uv, ["pip", "check", "--python", python]);
				const inventory = await run(python, ["-IS", "-c", PACKAGE_INVENTORY], {}, true);
				packageLabels = installedPackageLabels(packages, JSON.parse(inventory));
			} catch (error) {
				throw new Error(`Installing the Kernel packages failed; check python.packages in pi-ipython.json.\n${errorMessage(error)}`);
			}
		}
		await writeFile(path.join(venv, MARKER_FILE), `${JSON.stringify({ identity, packageLabels })}\n`);
		return { python, packageLabels };
	} catch (error) {
		throw new Error(
			`Failed to set up the Python Kernel venv at ${venv}. First-time setup needs internet to fetch Python ${version} and the runtime's dependencies.\n${redactPackageUrls(errorMessage(error))}`,
		);
	} finally {
		await release();
	}
}

async function readReadyLabels(venv: string, python: string, identity: string): Promise<string[] | undefined> {
	try {
		await access(python, constants.X_OK);
		const marker = JSON.parse(await readFile(path.join(venv, MARKER_FILE), "utf8")) as { identity?: unknown; packageLabels?: string[] };
		if (marker.identity === identity && Array.isArray(marker.packageLabels)) return marker.packageLabels;
	} catch {}
}

// Read distribution names without loading site hooks or copying direct-install URLs.
const PACKAGE_INVENTORY = `
import json, sys, sysconfig
from importlib.metadata import distributions
from pathlib import Path
root = str(Path(sys.executable).parent.parent)
paths = sysconfig.get_paths(vars={"base": root, "platbase": root})
print(json.dumps([{"name": d.metadata["Name"] or "", "direct": d.read_text("direct_url.json") is not None}
                  for d in distributions(path=list({paths["purelib"], paths["platlib"]}))]))
`;

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
	const hash = createHash("sha256").update(`python=${version}\0packages=${JSON.stringify(packages)}\0`);
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
	for (const dir of uvSearchDirs()) {
		const candidate = path.resolve(dir, exe);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new Error(`uv is required to set up the Python Kernel. Install it: ${UV_INSTALL_HINT}`);
}

function run(command: string, args: string[], env: Record<string, string> = {}, capture = false): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			// Do not pick up uv settings from the user's current project.
			cwd: RUNTIME_DIR,
			env: { ...process.env, ...env },
			stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(0, 4096);
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolve(stdout);
			// Arguments may contain private package URLs.
			else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}\n${stderr}`));
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
