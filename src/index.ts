import { randomUUID } from "node:crypto";
import path from "node:path";
import { type ExtensionAPI, getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { listPiTools } from "./bridge/pi-tool-listing.ts";
import { answerHostRequest, bridgedTools } from "./bridge/pi-tools.ts";
import { effectivePackages, effectivePrelude, hasDefaultPackages, loadConfig, type PiIpythonConfig } from "./config.ts";
import { ensureKernelPython, kernelPathEnv, resolveProjectPython, RUNTIME_SRC_DIR } from "./kernel/bootstrap.ts";
import { KernelClient } from "./kernel/client.ts";
import { hostJournalPath, reapDeadHosts } from "./kernel/orphans.ts";
import { extendSystemPrompt, piToolsSection } from "./prompt/system-prompt.ts";
import { preludeNames } from "./kernel/prelude.ts";
import { BackgroundNotices, isCancelledBackgroundNotice } from "./session/background-notices.ts";
import { createIpythonTool, IPYTHON_TOOL_NAME, kernelBootstrapCode, STATE_LOST_NOTICE } from "./tool/ipython-tool.ts";

export { STATE_LOST_NOTICE };

/**
 * pi-ipython extension entry. Loading it means exclusive mode: the model sees only the
 * `ipython` tool, backed by one Kernel per session that starts on the first Cell.
 */
export default function piIpython(pi: ExtensionAPI): void {
	let kernel: KernelClient | undefined;
	let warmPackageLabels: Promise<string[]> | undefined;
	let cwd = process.cwd();
	let config: PiIpythonConfig = loadConfig(cwd).config;
	let journalPath: string | undefined;
	/** A Python-state notice pi has not persisted yet; `sent` once a request has carried it. */
	let pendingStateNotice: { content: string; id: string; timestamp: number; sent: boolean } | undefined;
	/** Cause of a Kernel replacement the model has not been told about. */
	let unannouncedStateLoss: string | undefined;
	/** Python-state notices queued but never sent when their Kernel was replaced: dropped from context. */
	const voidedStateNotices = new Set<string>();
	/** The message each deferred notice followed, counting matches because timestamps can collide. */
	const stateNoticeAnchors = new Map<string, { key: string; occurrence: number }>();
	// A notice a request has carried stays (ADR 0006); the State-loss notice that follows corrects it.
	const voidPendingStateNotice = () => {
		if (pendingStateNotice && !pendingStateNotice.sent) voidedStateNotices.add(pendingStateNotice.id);
		pendingStateNotice = undefined;
	};
	const onLost = (error: Error) => {
		unannouncedStateLoss = error.message;
		voidPendingStateNotice();
		notices.drop();
	};

	/** The prelude statements of the current config. */
	const prelude = (): readonly string[] => effectivePrelude(config);
	/** Reports to the user: a UI notification, or stderr without a UI. Set on session start. */
	let report = (message: string, _type: "error" | "warning" | "info") => console.error(message);
	/** Whether pi has no run going. Set on session start. */
	let isIdle = () => false;
	const onBootstrapStderr = (stderr: string) => {
		for (const line of stderr.split("\n").filter((l) => l.trim())) report(`pi-ipython prelude: ${line}`, "warning");
	};

	// Answering `bash.completed` and `bash.consumed` at any time keeps the runtime from printing a warning
	// into background output; with notices off, both are acknowledged and dropped.
	const notices = new BackgroundNotices({
		isIdle: () => isIdle(),
		hasRunningCommand: () => kernel?.hasRunningCommand() ?? Promise.resolve(false),
		send: (message) => pi.sendMessage(message, { triggerTurn: true }),
		notify: (message) => report(message, "info"),
	});
	const hostHandlers = notices.hostHandlers;

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
		const packages = effectivePackages(config);
		return new KernelClient({
			cwd,
			resolvePython: async () => (await ensureKernelPython({ pythonVersion: version, packages })).python,
			bootstrapCode,
			onBootstrapStderr,
			env: kernelPathEnv(),
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
				notices.drop();
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
				const bridged = forceExclusive();
				const callable = new Set(ctx.tools.map((tool) => tool.name));
				return answerHostRequest(data, bridged.filter((tool) => callable.has(tool.name)), ctx, signal, config.piTools.search);
			},
			// The pi API while a Pi tool is callable, then the Listed Pi tools.
			describePiTools: (loadout) => {
				const bridged = new Set(bridgedTools(pi.getAllTools(), IPYTHON_TOOL_NAME).map((tool) => tool.name));
				if (!loadout.callable.some((tool) => bridged.has(tool.name))) return undefined;
				const listed = config.piTools.list ? listPiTools(loadout, bridged) : undefined;
				return [piToolsSection(config.piTools.search), ...(listed ? [listed] : [])].join("\n\n");
			},
		}),
	);

	pi.on("session_start", (event, ctx) => {
		pendingStateNotice = undefined;
		stateNoticeAnchors.clear();
		// A new session's Kernel is fresh; any loss is announced below, before its first turn.
		unannouncedStateLoss = undefined;
		cwd = ctx.cwd;
		const loaded = loadConfig(cwd, getAgentDir(), ctx.isProjectTrusted());
		config = loaded.config;
		report = (message, type) => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
			else console.error(message);
		};
		isIdle = () => ctx.isIdle();
		notices.reset();
		// Print and JSON modes exit once the prompt is done: nothing could start the turn.
		notices.enabled = config.backgroundNotices && (ctx.mode === "tui" || ctx.mode === "rpc");
		for (const error of loaded.errors) report(`pi-ipython config: ${error}`, "error");
		for (const warning of loaded.warnings) report(`pi-ipython config: ${warning}`, "warning");

		// Kernels of pi hosts that died without shutting them down.
		const journalDir = path.join(getAgentDir(), "pi-ipython", "journal");
		reapDeadHosts(journalDir);
		journalPath = hostJournalPath(journalDir);

		// Warm the venv in the background; a build failure resurfaces on the first Cell.
		warmPackageLabels = undefined;
		if (config.python.source === "uv") {
			const packages = effectivePackages(config);
			const warm = ensureKernelPython({ pythonVersion: config.python.version, packages })
				.then(({ packageLabels }) => packageLabels, () => []);
			warmPackageLabels = packages.length > 0 ? warm : Promise.resolve([]);
		}

		// Summaries can contain Python state even when their Cells are not on this branch.
		if (["resume", "fork"].includes(event.reason) || mayContainEarlierState(ctx.sessionManager.getBranch())) {
			pi.sendMessage({ customType: STATE_LOST_TYPE, content: STATE_LOST_NOTICE, display: false }, { deliverAs: "nextTurn" });
		}
		forceExclusive();
	});
	// Extend pi's prompt instead of replacing it (ADR 0005): the forced result keeps SYSTEM.md, APPEND_SYSTEM.md,
	// and other extensions' edits of `systemPrompt`, and stays fixed for the run.
	pi.on("before_agent_start", async (event, ctx) => {
		forceExclusive();
		const message = notices.onRunStart(event, () => ctx.abort());
		const packageLabels = await warmPackageLabels;
		const options = event.systemPromptOptions;
		// pi reconciles the hook's snapshot with the live loadout only after this handler returns.
		if (options.forceSystemPrompt === undefined) {
			options.selectedTools = pi.getActiveTools();
			options.hiddenTools = [...new Set([...options.hiddenTools, ...options.selectedTools.filter((name) => name !== IPYTHON_TOOL_NAME)])];
		}
		const systemPrompt = extendSystemPrompt(event.systemPrompt, options.skills ?? [], {
			// The prelude still runs with prompt off; only the model is not told about it.
			prelude: config.prelude.prompt ? { ...config.prelude, includeDefaultPackageImports: hasDefaultPackages(config) } : undefined,
			backgroundNotices: notices.enabled,
			packageLabels,
		}, { after: config.systemPrompt.ipythonAfter, before: config.systemPrompt.ipythonBefore });
		return { systemPrompt, ...(message ? { message } : {}) };
	});
	pi.on("agent_settled", (event) => notices.onSettled(event.aborted));
	// Python state follows the Kernel, not the conversation: on a branch switch the user decides whether it still fits.
	pi.on("session_tree", async (_event, ctx) => {
		voidPendingStateNotice();
		if (!kernel?.isRunning) return;
		const choice = ctx.mode === "tui" && ctx.hasUI
			? await ctx.ui.select("Branch switched. Python state may not match this branch.", [KEEP_KERNEL, RESTART_KERNEL])
			: KEEP_KERNEL;
		if (choice === RESTART_KERNEL) {
			notices.drop();
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
	pi.on("session_compact", async (event) => {
		if (event.reason === "manual") notices.afterManualCompaction();
		const current = kernel;
		if (!current?.isRunning) return;
		// `pi` and the prelude's names are re-created by the bootstrap, like `bash`, which the runtime already leaves out.
		const bootstrapNames = new Set(["pi", ...preludeNames(prelude())]);
		const listed = await current.listNames(AbortSignal.timeout(STATE_LISTING_TIMEOUT_MS));
		const names = listed?.filter((name) => !bootstrapNames.has(name)) ?? null;
		// A failed listing still gets a notice, unless the Kernel stopped meanwhile.
		if (names === null && !(kernel === current && current.isRunning)) return;
		pendingStateNotice = { content: pythonStateNotice(names), id: randomUUID(), timestamp: Date.now(), sent: false };
		// Persist immediately when idle; during a run pi defers this until turn-end.
		pi.sendMessage(
			{ customType: PYTHON_STATE_TYPE, content: pendingStateNotice.content, display: false, details: { noticeId: pendingStateNotice.id } },
			{ triggerTurn: false },
		);
	});
	pi.on("session_compact_failed", (event) => {
		if (event.reason === "manual") notices.afterManualCompaction();
	});
	pi.on("context", (event) => {
		const noticeId = (m: (typeof event.messages)[number]) => m.role === "custom" && m.customType === PYTHON_STATE_TYPE
			? (m.details as { noticeId?: string } | undefined)?.noticeId
			: undefined;
		// A notice its Kernel did not outlive must not claim that Python state persisted.
		const messages = event.messages.filter((m) =>
			!isCancelledBackgroundNotice(m) && !voidedStateNotices.has(noticeId(m) ?? ""));
		let changed = messages.length !== event.messages.length;
		// pi persists a deferred notice at turn end, after that turn's messages: put it back where requests carried it.
		for (const [id, { key, occurrence }] of stateNoticeAnchors) {
			const at = messages.findIndex((m) => noticeId(m) === id);
			if (at < 0) continue;
			let remaining = occurrence;
			const after = messages.findIndex((m) => messageKey(m) === key && --remaining === 0);
			if (after < 0 || after + 1 >= at) continue;
			messages.splice(after + 1, 0, ...messages.splice(at, 1));
			changed = true;
		}
		const notice = pendingStateNotice;
		if (!notice || messages.some((m) => noticeId(m) === notice.id)) {
			pendingStateNotice = undefined;
			return changed ? { messages } : undefined;
		}
		// Make the deferred notice visible to continuations and overflow retries without steering another turn.
		notice.sent = true;
		const last = messages.at(-1);
		if (last && !stateNoticeAnchors.has(notice.id)) {
			const key = messageKey(last);
			const occurrence = messages.filter((m) => messageKey(m) === key).length;
			stateNoticeAnchors.set(notice.id, { key, occurrence });
		}
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
		notices.drop();
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

/** Matches messages across requests; `context` handlers get copies, not the same objects. */
function messageKey(m: { role: string; timestamp?: number; toolCallId?: string }): string {
	return `${m.role}:${m.timestamp ?? ""}:${m.toolCallId ?? ""}`;
}

const KEEP_KERNEL = "Keep Kernel";
const RESTART_KERNEL = "Restart Kernel";

function mayContainEarlierState(branch: SessionEntry[]): boolean {
	return branch.some(
		(entry) => entry.type === "branch_summary" || entry.type === "compaction" ||
			(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === IPYTHON_TOOL_NAME),
	);
}
