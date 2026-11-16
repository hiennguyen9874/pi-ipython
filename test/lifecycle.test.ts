import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { STATE_LOST_NOTICE } from "../src/index.ts";
import { createHarness, type Harness, kernelPids, resultText } from "./harness.ts";

let h: Harness | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const SPAWN_CHILD = "import os, subprocess\np = subprocess.Popen(['sleep', '300'])\n(os.getpid(), p.pid)";

/** Alive and not a zombie. */
function isAlive(pid: number): boolean {
	try {
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

test("a Kernel left behind by a killed pi host is reaped when the extension next starts", async () => {
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
		expect(seen).toContain(STATE_LOST_NOTICE);
	},
);

test("a session without earlier Cells gets no state-lost notice", async () => {
	h = await createHarness({ sessionStartEvent: { type: "session_start", reason: "new" } });
	let seen = "";
	h.setResponses([
		(context) => {
			seen = JSON.stringify(context.messages);
			return fauxAssistantMessage(fauxToolCall("ipython", { code: "1" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("go");
	expect(seen).not.toContain(STATE_LOST_NOTICE);
});
