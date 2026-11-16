import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type PiIpythonConfig } from "./config.ts";
import { ensureKernelPython, resolveProjectPython, RUNTIME_SRC_DIR } from "./kernel/bootstrap.ts";
import { KernelClient } from "./kernel/client.ts";
import { buildSystemPrompt } from "./prompt/system-prompt.ts";
import { createIpythonTool, IPYTHON_TOOL_NAME, KERNEL_BOOTSTRAP_CODE } from "./tool/ipython-tool.ts";

/**
 * pi-ipython extension entry. Loading it means exclusive mode: the model sees only the
 * `ipython` tool, backed by one Kernel per session that starts on the first Cell.
 */
export default function piIpython(pi: ExtensionAPI): void {
	let kernel: KernelClient | undefined;
	let cwd = process.cwd();
	let config: PiIpythonConfig = loadConfig(cwd).config;

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
			});
		}
		return new KernelClient({
			cwd,
			resolvePython: () => ensureKernelPython({ pythonVersion: version }),
			bootstrapCode: KERNEL_BOOTSTRAP_CODE,
		});
	};

	pi.registerTool(
		createIpythonTool(
			() => (kernel ??= createKernel()),
			() => config.output,
		),
	);

	const forceExclusive = () => pi.setActiveTools([IPYTHON_TOOL_NAME]);

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		const loaded = loadConfig(cwd);
		config = loaded.config;
		for (const error of loaded.errors) {
			const message = `pi-ipython config: ${error}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		}
		forceExclusive();
	});
	pi.on("before_agent_start", (event) => {
		forceExclusive();
		return { systemPrompt: buildSystemPrompt(event.systemPromptOptions) };
	});
	pi.on("session_shutdown", async () => {
		await kernel?.shutdown();
		kernel = undefined;
	});
}
