import { fauxAssistantMessage, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { PYTHON_STATE_TYPE } from "../src/index.ts";
import { DEFAULT_PRELUDE } from "../src/kernel/prelude.ts";
import { createHarness, type Harness, resultText } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const usesDefaults = "(json.dumps({'a': 1}), Path('x/y').name, re.sub('b', 'c', 'ab'), os.sep, sys.version_info[0], math.floor(1.5), "
	+ "datetime(2020, 1, 2).day, timedelta(days=1).days, Counter('aab')['a'], defaultdict(int)['k'], "
	+ "time.time() > 0, shutil.which is not None, list(itertools.repeat(0, 1)), functools.reduce(int.__add__, [1, 2]), "
	+ "collections.deque([1]).pop(), textwrap.dedent(' x'))";
const defaultsResult = "('{\"a\": 1}', 'y', 'ac', '/', 3, 1, 2, 1, 2, 0, True, True, [0], 3, 1, 'x')";

test.skipIf(process.platform === "win32")("a first Cell uses the default prelude's names without importing them", async () => {
	h = await createHarness();
	const [r] = await h.runCells(usesDefaults);
	expect(r!.isError).toBe(false);
	expect(resultText(r!)).toBe(defaultsResult);
});

test.skipIf(process.platform === "win32")("the prelude runs again after a Kernel replacement", async () => {
	h = await createHarness();
	await h.runCells("import os as _os\n_os.getpid()");
	// The Kernel dies under this Cell, whose result carries the State-loss notice; the next Cell gets a new Kernel.
	const [died] = await h.runCells("import os as _os\n_os._exit(3)");
	expect(died!.details).toMatchObject({ stateLost: true });
	const [fresh] = await h.runCells(usesDefaults);
	expect(resultText(fresh!)).toBe(defaultsResult);
});

test("the system prompt lists the prelude statements", async () => {
	h = await createHarness();
	let prompt = "";
	h.setResponses([
		(context) => {
			prompt = getSystemMessageText(context.messages.find((m) => m.role === "system")!);
			return fauxAssistantMessage("hi");
		},
	]);
	await h.session.prompt("hi");
	for (const statement of DEFAULT_PRELUDE) expect(prompt).toContain(`\`${statement}\``);
});

test("the Python-state notice leaves prelude names out, even re-imported ones", async () => {
	h = await createHarness();
	await h.runCells("a = 1\nimport json\nfrom pathlib import Path");
	h.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
	h.setResponses([fauxAssistantMessage("Summary."), fauxAssistantMessage("Prefix summary.")]);
	await h.session.compact();
	const notice = h.session.sessionManager.getBranch()
		.flatMap((e) => (e.type === "custom_message" && e.customType === PYTHON_STATE_TYPE ? [e] : []))
		.at(-1);
	expect(notice?.content).toContain("These names are still defined: a.");
});
