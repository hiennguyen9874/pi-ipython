import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureKernelPython } from "./kernel/bootstrap.ts";
import { KernelClient } from "./kernel/client.ts";
import { createIpythonTool, IPYTHON_TOOL_NAME, KERNEL_BOOTSTRAP_CODE } from "./tool/ipython-tool.ts";

/**
 * pi-ipython extension entry. Loading it means exclusive mode: the model sees only the
 * `ipython` tool, backed by one Kernel per session that starts on the first Cell.
 */
export default function piIpython(pi: ExtensionAPI): void {
	let kernel: KernelClient | undefined;
	let cwd = process.cwd();

	pi.registerTool(
		createIpythonTool(() => {
			kernel ??= new KernelClient({
				cwd,
				resolvePython: () => ensureKernelPython(),
				bootstrapCode: KERNEL_BOOTSTRAP_CODE,
			});
			return kernel;
		}),
	);

	const forceExclusive = () => pi.setActiveTools([IPYTHON_TOOL_NAME]);

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		forceExclusive();
	});
	pi.on("before_agent_start", forceExclusive);
	pi.on("session_shutdown", async () => {
		await kernel?.shutdown();
		kernel = undefined;
	});
}
