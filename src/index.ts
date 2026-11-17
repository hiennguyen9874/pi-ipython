import { randomUUID } from "node:crypto";
import path from "node:path";
import { type ExtensionAPI, getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig, type PiIpythonConfig } from "./config.ts";
import { ensureKernelPython, resolveProjectPython, RUNTIME_SRC_DIR } from "./kernel/bootstrap.ts";
import { KernelClient } from "./kernel/client.ts";
import { hostJournalPath, reapDeadHosts } from "./kernel/orphans.ts";
import { buildSystemPrompt } from "./prompt/system-prompt.ts";
import { createIpythonTool, IPYTHON_TOOL_NAME, KERNEL_BOOTSTRAP_CODE, STATE_LOST_NOTICE } from "./tool/ipython-tool.ts";

export { STATE_LOST_NOTICE };

/**
 * pi-ipython extension entry. Loading it means exclusive mode: the model sees only the
 * `ipython` tool, backed by one Kernel per session that starts on the first Cell.
 */
export default function piIpython(pi: ExtensionAPI): void {
	let kernel: KernelClient | undefined;
	let cwd = process.cwd();
	let config: PiIpythonConfig = loadConfig(cwd).config;
	let journalPath: string | undefined;
	let pendingStateNotice: { content: string; id: string; timestamp: number } | undefined;
	/** Cause of a Kernel replacement the model has not been told about. */
	let unannouncedStateLoss: string | undefined;
	/** Python-state notices already queued when their Kernel was replaced: dropped from context. */
	const voidedStateNotices = new Set<string>();
	const voidPendingStateNotice = () => {
		if (pendingStateNotice) voidedStateNotices.add(pendingStateNotice.id);
		pendingStateNotice = undefined;
	};
	const onLost = (error: Error) => {
		unannouncedStateLoss = error.message;
		voidPendingStateNotice();
	};

	const createKernel = (): KernelClient => {
		const { source, version } = config.python;
		if (source === "project") {
			// The project venv lacks the runtime: import it from the package's vendored sources.
			const pythonPath = [RUNTIME_SRC_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
			return new KernelClient({
				cwd,
				resolvePython: () => resolveProjectPython(cwd),
				bootstrapCode: KERNEL_BOOTSTRAP_CODE,
				env: { PYTHONPATH: pythonPath },
				journalPath,
				onLost,
			});
		}
		return new KernelClient({
			cwd,
			resolvePython: () => ensureKernelPython({ pythonVersion: version }),
			bootstrapCode: KERNEL_BOOTSTRAP_CODE,
			journalPath,
			onLost,
		});
	};

	pi.registerTool(
		createIpythonTool({
			getKernel: () => (kernel ??= createKernel()),
			killKernel: async () => {
				voidPendingStateNotice();
				await kernel?.shutdown();
				kernel = undefined;
			},
			getOutputLimits: () => config.output,
			getConfirmEachCell: () => config.confirmEachCell,
			takeStateLoss: () => {
				const cause = unannouncedStateLoss;
				unannouncedStateLoss = undefined;
				return cause;
			},
		}),
	);

	const forceExclusive = () => pi.setActiveTools([IPYTHON_TOOL_NAME]);

	pi.on("session_start", (event, ctx) => {
		pendingStateNotice = undefined;
		// A new session's Kernel is fresh; any loss is announced below, before its first turn.
		unannouncedStateLoss = undefined;
		cwd = ctx.cwd;
		const loaded = loadConfig(cwd);
		config = loaded.config;
		for (const error of loaded.errors) {
			const message = `pi-ipython config: ${error}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		}

		// Kernels of pi hosts that died without shutting them down.
		const journalDir = path.join(getAgentDir(), "pi-ipython", "journal");
		reapDeadHosts(journalDir);
		journalPath = hostJournalPath(journalDir);

		// Warm the venv so the first Cell does not wait for it; a failure resurfaces on that Cell.
		if (config.python.source === "uv") ensureKernelPython({ pythonVersion: config.python.version }).catch(() => undefined);

		// Every session starts with a fresh Kernel: Cells already in the conversation ran in one that is gone.
		if (["new", "resume", "fork"].includes(event.reason) || hasEarlierCells(ctx.sessionManager.getBranch())) {
			pi.sendMessage({ customType: STATE_LOST_TYPE, content: STATE_LOST_NOTICE, display: true }, { deliverAs: "nextTurn" });
		}
		forceExclusive();
	});
	pi.on("before_agent_start", (event) => {
		forceExclusive();
		return { systemPrompt: buildSystemPrompt(event.systemPromptOptions) };
	});
	// Python state follows the Kernel, not the conversation: on a branch switch the user decides whether it still fits.
	pi.on("session_tree", async (_event, ctx) => {
		voidPendingStateNotice();
		if (!kernel?.isRunning) return;
		const choice = ctx.mode === "tui" && ctx.hasUI
			? await ctx.ui.select("Branch switched. Python state may not match this branch.", [KEEP_KERNEL, RESTART_KERNEL])
			: KEEP_KERNEL;
		if (choice === RESTART_KERNEL) {
			await kernel.shutdown();
			kernel = undefined;
			unannouncedStateLoss = undefined;
			pi.sendMessage({ customType: STATE_LOST_TYPE, content: STATE_LOST_NOTICE, display: true }, { deliverAs: "nextTurn" });
		} else {
			pi.sendMessage({ customType: BRANCH_NOTICE_TYPE, content: BRANCH_NOTICE, display: true }, { deliverAs: "nextTurn" });
		}
	});
	// Compaction summarises the conversation, but the Kernel keeps its namespace: tell the model what survived.
	pi.on("session_compact", async () => {
		const current = kernel;
		if (!current?.isRunning) return;
		const names = await current.listNames(AbortSignal.timeout(STATE_LISTING_TIMEOUT_MS));
		// A failed listing still gets a notice, unless the Kernel stopped meanwhile.
		if (names === null && !(kernel === current && current.isRunning)) return;
		pendingStateNotice = { content: pythonStateNotice(names), id: randomUUID(), timestamp: Date.now() };
		// Persist immediately when idle; during a run pi defers this until turn-end.
		pi.sendMessage(
			{ customType: PYTHON_STATE_TYPE, content: pendingStateNotice.content, display: false, details: { noticeId: pendingStateNotice.id } },
			{ triggerTurn: false },
		);
	});
	pi.on("context", (event) => {
		const noticeId = (m: (typeof event.messages)[number]) => m.role === "custom" && m.customType === PYTHON_STATE_TYPE
			? (m.details as { noticeId?: string } | undefined)?.noticeId
			: undefined;
		// A notice its Kernel did not outlive must not claim that Python state persisted.
		const messages = voidedStateNotices.size === 0
			? event.messages
			: event.messages.filter((m) => !voidedStateNotices.has(noticeId(m) ?? ""));
		const notice = pendingStateNotice;
		if (!notice || messages.some((m) => noticeId(m) === notice.id)) {
			pendingStateNotice = undefined;
			return messages === event.messages ? undefined : { messages };
		}
		// Make the deferred notice visible to continuations and overflow retries without steering another turn.
		return { messages: [...messages, {
			role: "custom" as const,
			customType: PYTHON_STATE_TYPE,
			content: notice.content,
			display: false,
			details: { noticeId: notice.id },
			timestamp: notice.timestamp,
		}] };
	});
	pi.on("session_shutdown", async () => {
		pendingStateNotice = undefined;
		await kernel?.shutdown();
		kernel = undefined;
	});
}

export const STATE_LOST_TYPE = "ipython_state_lost";

export const BRANCH_NOTICE_TYPE = "ipython_branch_switch";
export const BRANCH_NOTICE =
	"The conversation switched to another branch, but the Python Kernel kept running: its variables, functions, and imports may come from Cells that are not on this branch, and Cells on this branch may not have run in it. Check Python state before relying on it.";
export const PYTHON_STATE_TYPE = "ipython_state";
// A stuck Kernel degrades the notice to no names instead of holding up compaction.
const STATE_LISTING_TIMEOUT_MS = 5_000;

/** The Python-state notice; `names` is null when the listing failed. Wording from Unharnessed's ipython_state. */
function pythonStateNotice(names: string[] | null): string {
	const detail = names === null
		? ""
		: names.length > 0
			? ` These names are still defined: ${names.join(", ")}.`
			: " You have not defined any names yet.";
	return `[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.${detail}`;
}

const KEEP_KERNEL = "Keep Kernel";
const RESTART_KERNEL = "Restart Kernel";

function hasEarlierCells(branch: SessionEntry[]): boolean {
	return branch.some(
		(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === IPYTHON_TOOL_NAME,
	);
}
