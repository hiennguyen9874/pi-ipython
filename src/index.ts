import { randomUUID } from "node:crypto";
import path from "node:path";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { type BeforeAgentStartEvent, type ExtensionAPI, getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { listPiTools } from "./bridge/pi-tool-listing.ts";
import { answerHostRequest, bridgedTools } from "./bridge/pi-tools.ts";
import { effectivePrelude, loadConfig, type PiIpythonConfig } from "./config.ts";
import { ensureKernelPython, resolveProjectPython, RUNTIME_SRC_DIR } from "./kernel/bootstrap.ts";
import { KernelClient } from "./kernel/client.ts";
import { hostJournalPath, reapDeadHosts } from "./kernel/orphans.ts";
import { buildSystemPrompt } from "./prompt/system-prompt.ts";
import { preludeNames } from "./kernel/prelude.ts";
import { createIpythonTool, IPYTHON_TOOL_NAME, kernelBootstrapCode, STATE_LOST_NOTICE } from "./tool/ipython-tool.ts";

export { STATE_LOST_NOTICE };

/**
 * pi-ipython extension entry. Loading it means exclusive mode: the model sees only the
 * `ipython` tool, backed by one Kernel per session that starts on the first Cell.
 */
export default function piIpython(pi: ExtensionAPI): void {
	let kernel: KernelClient | undefined;
	let promptOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
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

	/** The prelude statements of the current config. */
	const prelude = (): readonly string[] => effectivePrelude(config);
	/** Reports to the user: a UI notification, or stderr without a UI. Set on session start. */
	let report = (message: string, _type: "error" | "warning") => console.error(message);
	const onBootstrapStderr = (stderr: string) => {
		for (const line of stderr.split("\n").filter((l) => l.trim())) report(`pi-ipython prelude: ${line}`, "warning");
	};

	// The runtime reports a finished Background command (`bash.completed`) and a later read of its handle
	// (`bash.consumed`). No notice reaches the model, so both are acknowledged and dropped; any other reply
	// makes the runtime print a warning into background output.
	const hostHandlers = {
		"bash.completed": async () => ({}),
		"bash.consumed": async () => ({}),
	};

	const getOutputLimits = () => config.output;

	const createKernel = (): KernelClient => {
		const { source, version } = config.python;
		const bootstrapCode = kernelBootstrapCode(prelude());
		if (source === "project") {
			// The project venv lacks the runtime: import it from the package's vendored sources.
			const pythonPath = [RUNTIME_SRC_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
			return new KernelClient({
				cwd,
				resolvePython: () => resolveProjectPython(cwd),
				bootstrapCode,
				onBootstrapStderr,
				env: { PYTHONPATH: pythonPath },
				journalPath,
				onLost,
				hostHandlers,
				getOutputLimits,
			});
		}
		return new KernelClient({
			cwd,
			resolvePython: () => ensureKernelPython({ pythonVersion: version }),
			bootstrapCode,
			onBootstrapStderr,
			journalPath,
			onLost,
			hostHandlers,
			getOutputLimits,
		});
	};

	// Keep live discovery and Bridged calls aligned; ipython's prepareLoadout hides direct declarations.
	const forceExclusive = () => {
		const callable = bridgedTools(pi.getAllTools(), IPYTHON_TOOL_NAME);
		const direct = callable.filter((tool) => tool.exposure === "direct");
		pi.setActiveTools([IPYTHON_TOOL_NAME, ...direct.map((tool) => tool.name)]);
		return callable;
	};

	pi.registerTool(
		createIpythonTool({
			getKernel: () => (kernel ??= createKernel()),
			killKernel: async () => {
				voidPendingStateNotice();
				await kernel?.shutdown();
				kernel = undefined;
			},
			getOutputLimits,
			getConfirmEachCell: () => config.confirmEachCell,
			takeStateLoss: () => {
				const cause = unannouncedStateLoss;
				unannouncedStateLoss = undefined;
				return cause;
			},
			answerHostRequest: (data, ctx, signal) => {
				return answerHostRequest(data, forceExclusive(), ctx, signal, config.piTools.search);
			},
			describePiTools: (loadout) => config.piTools.list
				? listPiTools(loadout, new Set(bridgedTools(pi.getAllTools(), IPYTHON_TOOL_NAME).map((tool) => tool.name)))
				: undefined,
		}),
	);

	pi.on("session_start", (event, ctx) => {
		promptOptions = undefined;
		pendingStateNotice = undefined;
		// A new session's Kernel is fresh; any loss is announced below, before its first turn.
		unannouncedStateLoss = undefined;
		cwd = ctx.cwd;
		const loaded = loadConfig(cwd);
		config = loaded.config;
		report = (message, type) => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
			else console.error(message);
		};
		for (const error of loaded.errors) report(`pi-ipython config: ${error}`, "error");

		// Kernels of pi hosts that died without shutting them down.
		const journalDir = path.join(getAgentDir(), "pi-ipython", "journal");
		reapDeadHosts(journalDir);
		journalPath = hostJournalPath(journalDir);

		// Warm the venv so the first Cell does not wait for it; a failure resurfaces on that Cell.
		if (config.python.source === "uv") ensureKernelPython({ pythonVersion: config.python.version }).catch(() => undefined);

		// Summaries can contain Python state even when their Cells are not on this branch.
		if (["resume", "fork"].includes(event.reason) || mayContainEarlierState(ctx.sessionManager.getBranch())) {
			pi.sendMessage({ customType: STATE_LOST_TYPE, content: STATE_LOST_NOTICE, display: false }, { deliverAs: "nextTurn" });
		}
		forceExclusive();
	});
	pi.on("before_agent_start", (event) => {
		promptOptions = event.systemPromptOptions;
		// Own the provider projection below, instead of freezing a forced string for the whole run.
		promptOptions.forceSystemPrompt = undefined;
		forceExclusive();
	});
	// MCP can register tools after before_agent_start, including while a Cell waits for readiness.
	// Project one leading prompt from the live callable set before every provider request,
	// preserving the current declarations while leaving the persisted transcript untouched.
	pi.on("context_with_system", (event) => {
		if (!promptOptions) return;
		const current = getCurrentSystemMessage(event.messages);
		const head = {
			role: "system" as const,
			content: buildSystemPrompt(
				promptOptions,
				bridgedTools(pi.getAllTools(), IPYTHON_TOOL_NAME).length > 0 ? { search: config.piTools.search } : undefined,
				// The prelude still runs with prompt off; only the model is not told about it.
				config.prelude.prompt ? config.prelude : undefined,
			),
			...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
			timestamp: current?.timestamp ?? Date.now(),
		};
		return { messages: [head, ...event.messages.filter((message) => message.role !== "system")] };
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
			pi.sendMessage({ customType: STATE_LOST_TYPE, content: STATE_LOST_NOTICE, display: false }, { deliverAs: "nextTurn" });
			ctx.ui.notify?.("Kernel stopped; earlier Python state is unavailable.", "info");
		} else {
			pi.sendMessage({ customType: BRANCH_NOTICE_TYPE, content: BRANCH_NOTICE, display: false }, { deliverAs: "nextTurn" });
		}
	});
	// Compaction summarises the conversation, but the Kernel keeps its namespace: tell the model what survived.
	pi.on("session_compact", async () => {
		const current = kernel;
		if (!current?.isRunning) return;
		// `pi` and the prelude's names are re-created by the bootstrap, like `bash`, which the runtime already leaves out.
		const bootstrapNames = new Set(["pi", ...preludeNames(prelude())]);
		const listed = await current.listNames(AbortSignal.timeout(STATE_LISTING_TIMEOUT_MS));
		const names = listed?.filter((name) => !bootstrapNames.has(name)) ?? null;
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

const STATE_NOTICE_MAX_NAMES = 50;
// Includes all wording and escaped names; JavaScript string length counts UTF-16 code units.
const STATE_NOTICE_MAX_CHARS = 2_000;

/** The Python-state notice; `names` is null when the listing failed. */
function pythonStateNotice(names: string[] | null): string {
	const base = "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.";
	if (names === null) return `${base} Could not list Python names; inspect \`globals()\`.`;

	const filtered = " Private and bootstrap names are not listed.";
	if (names.length === 0) return `${base}${filtered} No eligible names to list.`;

	const omittedText = (count: number) => count > 0 ? ` ${count} more omitted; inspect \`globals()\`.` : "";
	const listed: string[] = [];
	for (const name of names) {
		if (listed.length === STATE_NOTICE_MAX_NAMES) break;
		// Arbitrary globals() keys can contain separators and newlines; keep ordinary names readable.
		const rendered = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
		const candidate = [...listed, rendered];
		const text = `${base}${filtered} These names are still defined: ${candidate.join(", ")}.${omittedText(names.length - candidate.length)}`;
		if (text.length > STATE_NOTICE_MAX_CHARS) break;
		listed.push(rendered);
	}
	const detail = listed.length > 0 ? ` These names are still defined: ${listed.join(", ")}.` : "";
	return `${base}${filtered}${detail}${omittedText(names.length - listed.length)}`;
}

const KEEP_KERNEL = "Keep Kernel";
const RESTART_KERNEL = "Restart Kernel";

function mayContainEarlierState(branch: SessionEntry[]): boolean {
	return branch.some(
		(entry) => entry.type === "branch_summary" || entry.type === "compaction" ||
			(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === IPYTHON_TOOL_NAME),
	);
}
