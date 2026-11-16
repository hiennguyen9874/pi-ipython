import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	type FileEntry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piIpython from "../src/index.ts";

export interface HarnessOptions {
	/** Runs before the session starts, e.g. to write config files. */
	setup?: (dirs: { cwd: string; agentDir: string }) => void | Promise<void>;
	/** Bind a UI with these methods (the rest are no-ops); without it the session is headless. */
	ui?: Partial<ExtensionUIContext>;
	/** Use this agent dir (kept on dispose) instead of a fresh one. */
	agentDir?: string;
	/** Start the session from these entries (header first), e.g. a previous session's `fileEntries()`. */
	entries?: FileEntry[];
	/** Defaults to `{ type: "session_start", reason: "startup" }`. */
	sessionStartEvent?: { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork" };
}

export interface Harness {
	session: AgentSession;
	resourceLoader: DefaultResourceLoader;
	cwd: string;
	agentDir: string;
	/** The session's header and entries, to start another session from. */
	fileEntries(): FileEntry[];
	/** Queue scripted model replies. */
	setResponses(responses: FauxResponseStep[]): void;
	/** Have the model run each code string as one ipython Cell in a single turn; returns the tool results. */
	runCells(...codes: string[]): Promise<ToolResultMessage[]>;
	dispose(): Promise<void>;
}

/** Text the model sees in a tool result. */
export function resultText(message: ToolResultMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Pids of Kernel processes (`python -m rlm.repl`) that are children of this test process. */
export function kernelPids(): number[] {
	if (process.platform === "win32") {
		const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
			`Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${process.pid} -and ($_.CommandLine -match 'windows-kernel.py|-m rlm.repl') } | ForEach-Object { $_.ProcessId }`],
			{ encoding: "utf8" });
		return output.trim() ? output.trim().split(/\s+/).map(Number) : [];
	}
	const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
	return ps.split("\n").flatMap((line) => {
		const [pid, ppid, ...args] = line.trim().split(/\s+/);
		return Number(ppid) === process.pid && args.join(" ").includes("-m rlm.repl") ? [Number(pid)] : [];
	});
}

/**
 * A real pi SDK session with pi-ipython loaded as an inline extension factory and a
 * faux provider playing the model. cwd and agentDir are fresh temp dirs, so no user
 * or project resources leak in.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-ipython-test-"));
	const cwd = join(root, "work");
	const agentDir = options.agentDir ?? join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// The extension finds its global config through pi's agent dir.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await options.setup?.({ cwd, agentDir });

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "pi-ipython", factory: piIpython }],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd, undefined, options.entries),
		sessionStartEvent: options.sessionStartEvent,
	});
	const ui = options.ui;
	await session.bindExtensions(
		ui ? { uiContext: new Proxy(ui, { get: (t, k) => t[k as keyof typeof t] ?? (() => undefined) }) as ExtensionUIContext } : {},
	);

	return {
		session,
		resourceLoader,
		cwd,
		agentDir,
		fileEntries: () => [session.sessionManager.getHeader()!, ...session.sessionManager.getEntries()],
		setResponses: (responses) => faux.setResponses(responses),
		async runCells(...codes) {
			const before = session.messages.length;
			faux.setResponses([
				...codes.map((code) => fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" })),
				fauxAssistantMessage("done"),
			]);
			await session.prompt("run the cells");
			return session.messages
				.slice(before)
				.filter((m): m is ToolResultMessage => m.role === "toolResult");
		},
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
