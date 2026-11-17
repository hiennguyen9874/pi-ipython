import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { STATE_LOST_NOTICE } from "../src/index.ts";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

/** The State-loss notice as it appears in a JSON-stringified context. */
const SEEN_STATE_LOST = JSON.stringify(STATE_LOST_NOTICE).slice(1, -1);

let h: Harness | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const SPAWN_CHILD = "import os, subprocess, sys\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n(os.getpid(), p.pid)";

/** Alive and not a zombie. */
function isAlive(pid: number): boolean {
	try {
		if (process.platform === "win32") {
			return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
				`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`],
				{ encoding: "utf8" }).trim() === "alive";
		}
		const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return stat !== "" && !stat.startsWith("Z");
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await sleep(100);
	}
	return true;
}

function pidsOf(text: string): [number, number] {
	const [kernel, child] = text.match(/\d+/g)!.map(Number);
	return [kernel!, child!];
}

test("the venv is prepared at session start, before any Cell", async () => {
	const venvRoot = mkdtempSync(join(tmpdir(), "pi-ipython-warm-"));
	const previous = process.env.PI_IPYTHON_VENV_DIR;
	process.env.PI_IPYTHON_VENV_DIR = join(venvRoot, "venv");
	cleanups.push(() => {
		process.env.PI_IPYTHON_VENV_DIR = previous;
		rmSync(venvRoot, { recursive: true, force: true });
	});

	h = await createHarness();
	expect(await waitFor(() => existsSync(join(venvRoot, "venv", ".pi-ipython-bootstrap.json")), 120_000)).toBe(true);
	expect(kernelPids()).toEqual([]);
}, 150_000);

test.each(["quit", "reload", "new", "resume", "fork"] as const)(
	"session shutdown (%s) kills the Kernel and its child processes",
	async (reason) => {
		h = await createHarness();
		const [r] = await h.runCells(SPAWN_CHILD);
		const [kernel, child] = pidsOf(resultText(r!));
		expect(isAlive(child)).toBe(true);

		await h.session.extensionRunner.emit({ type: "session_shutdown", reason });
		expect(isAlive(kernel)).toBe(false);
		expect(await waitFor(() => !isAlive(child))).toBe(true);
	},
);

test.skipIf(process.platform === "win32")("a Kernel left behind by a killed pi host is reaped when the extension next starts", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ipython-agent-"));
	cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
	const script = `
import { createHarness, resultText } from ${JSON.stringify(new URL("./harness.ts", import.meta.url).href)};
const h = await createHarness({ agentDir: ${JSON.stringify(agentDir)} });
const [r] = await h.runCells(${JSON.stringify(SPAWN_CHILD)});
console.log(resultText(r));
setInterval(() => {}, 1000);
`;
	const host = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise((resolve) => host.once("exit", resolve));
	cleanups.push(() => host.kill("SIGKILL"));
	const line = await new Promise<string>((resolve, reject) => {
		host.stdout.setEncoding("utf8");
		host.stdout.on("data", (text: string) => text.includes("(") && resolve(text));
		host.once("exit", () => reject(new Error("host exited before running the Cell")));
	});
	const [kernel, child] = pidsOf(line);
	cleanups.push(() => {
		for (const pid of [kernel, child]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	});

	// A stopped Kernel cannot notice its owner died, like a Kernel wedged in native code.
	process.kill(kernel, "SIGSTOP");
	host.kill("SIGKILL");
	await exited;
	expect(isAlive(kernel)).toBe(true);
	expect(isAlive(child)).toBe(true);

	h = await createHarness({ agentDir });
	expect(await waitFor(() => !isAlive(kernel) && !isAlive(child))).toBe(true);
});

test.each(["resume", "fork", "startup"] as const)(
	"after %s of a session with earlier Cells, the model is told Python state is gone before its next turn",
	async (reason) => {
		h = await createHarness();
		await h.runCells("x = 1");
		const entries = h.fileEntries();
		await h.dispose();
		h = undefined;

		h = await createHarness({ entries, sessionStartEvent: { type: "session_start", reason } });
		let seen = "";
		h.setResponses([
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage("noted");
			},
		]);
		await h.session.prompt("continue");
		expect(seen).toContain(SEEN_STATE_LOST);
	},
);

test.each(["new", "resume", "fork"] as const)("an explicit %s session is notified even without earlier Cells", async (reason) => {
	h = await createHarness({ sessionStartEvent: { type: "session_start", reason } });
	let seen = "";
	h.setResponses([(context) => {
		seen = JSON.stringify(context.messages);
		return fauxAssistantMessage("noted");
	}]);
	await h.session.prompt("continue");
	expect(seen).toContain(SEEN_STATE_LOST);
});

test("a live host with an unknown recorded identity keeps its Kernel", async () => {
	h = await createHarness();
	const [result] = await h.runCells("import os; os.getpid()");
	const pid = Number(resultText(result!));
	const dir = join(h.agentDir, "pi-ipython", "journal");
	const name = readdirSync(dir).find((name) => name.startsWith(`${process.pid}-`))!;
	renameSync(join(dir, name), join(dir, `${process.pid}-unknown.jsonl`));

	await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	expect(isAlive(pid)).toBe(true);
	const [next] = await h.runCells("40 + 2");
	expect(resultText(next!)).toBe("42");
});

test("unresolved journal records are kept and retried once identity is available", async () => {
	h = await createHarness();
	const [result] = await h.runCells("import os; os.getpid()");
	const pid = Number(resultText(result!));
	const dir = join(h.agentDir, "pi-ipython", "journal");
	const ownJournal = join(dir, readdirSync(dir).find((name) => name.startsWith(`${process.pid}-`))!);
	const original = readFileSync(ownJournal, "utf8");
	// No process can have this host pid on supported platforms.
	const abandoned = join(dir, "2147483647-unknown.jsonl");
	writeFileSync(abandoned, JSON.stringify({ version: 1, pid, active: true }) + "\n");

	await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	expect(existsSync(abandoned)).toBe(true);
	expect(isAlive(pid)).toBe(true);

	writeFileSync(abandoned, original);
	await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	expect(await waitFor(() => !isAlive(pid))).toBe(true);
	expect(existsSync(abandoned)).toBe(false);
});

test("an unreadable journal is retained without failing session startup", async () => {
	h = await createHarness();
	const journal = join(h.agentDir, "pi-ipython", "journal", "2147483647-unknown.jsonl");
	// A directory deterministically fails readFile, including when tests run as root.
	mkdirSync(journal, { recursive: true });
	await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	expect(existsSync(journal)).toBe(true);
	const [result] = await h.runCells("40 + 2");
	expect(resultText(result!)).toBe("42");
});

test.skipIf(process.platform === "win32")("a historical dead leader never authorizes killing an unverified group", async () => {
	const leader = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		console.log(child.pid);
		child.unref();
	`], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
	const exited = new Promise((resolve) => leader.once("exit", resolve));
	const child = await new Promise<number>((resolve, reject) => {
		leader.stdout!.once("data", (data) => resolve(Number(String(data).trim())));
		leader.once("error", reject);
	});
	cleanups.push(() => {
		try { process.kill(child, "SIGKILL"); } catch {}
	});
	await exited;
	expect(isAlive(child)).toBe(true);

	h = await createHarness({ setup: ({ agentDir }) => {
		const dir = join(agentDir, "pi-ipython", "journal");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2147483647-unknown.jsonl"), JSON.stringify({
			version: 1, pid: leader.pid, processStartId: "historical-identity", active: true,
		}) + "\n");
	} });
	expect(isAlive(child)).toBe(true);
});

test.skipIf(process.platform !== "win32")("Windows kills ordinary children even when the Kernel exits abruptly", async () => {
	h = await createHarness();
	const [result] = await h.runCells(SPAWN_CHILD);
	const [kernel, child] = pidsOf(resultText(result!));
	expect(isAlive(child)).toBe(true);
	await h.runCells("os._exit(1)");
	expect(await waitFor(() => !isAlive(kernel) && !isAlive(child))).toBe(true);
});

test("a fresh startup without earlier Cells gets no state-lost notice", async () => {
	h = await createHarness();
	let seen = "";
	h.setResponses([
		(context) => {
			seen = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "1" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("go");
	expect(seen).not.toContain(SEEN_STATE_LOST);
});
