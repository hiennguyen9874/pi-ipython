import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

test("session loads the extension and returns a scripted reply", async () => {
	h = await createHarness();
	const { extensions, errors } = h.resourceLoader.getExtensions();
	expect(errors).toEqual([]);
	expect(extensions.map((e) => e.path)).toEqual(["<inline:pi-ipython>"]);

	h.setResponses([fauxAssistantMessage("hello from faux")]);
	await h.session.prompt("hi");

	expect(h.session.getLastAssistantText()).toBe("hello from faux");
});
