import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piIpython from "../src/index.ts";

export interface Harness {
	session: AgentSession;
	resourceLoader: DefaultResourceLoader;
	cwd: string;
	/** Queue scripted model replies. */
	setResponses(responses: FauxResponseStep[]): void;
	dispose(): Promise<void>;
}

/**
 * A real pi SDK session with pi-ipython loaded as an inline extension factory and a
 * faux provider playing the model. cwd and agentDir are fresh temp dirs, so no user
 * or project resources leak in.
 */
export async function createHarness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-ipython-test-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");

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
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({});

	return {
		session,
		resourceLoader,
		cwd,
		setResponses: (responses) => faux.setResponses(responses),
		async dispose() {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
