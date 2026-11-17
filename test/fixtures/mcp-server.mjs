// Minimal stdio MCP server for real-session tests; no network or external packages.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

// Arguments: an optional readiness gate file, and `--resources` to offer one resource.
const args = process.argv.slice(2);
const resources = args.includes("--resources");
const gate = args.find((arg) => arg !== "--resources");
const page = { uri: "docs://pages/intro", name: "intro", mimeType: "text/markdown" };
const inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	switch (request.method) {
		case "initialize":
			result = {
				protocolVersion: request.params.protocolVersion,
				capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
				serverInfo: { name: "test-docs", version: "1.0.0" },
				instructions: "Docs server.\nSearch before you look up a page.",
			};
			break;
		case "tools/list":
			// Readiness tests open this gate only when the first Cell is called.
			while (gate && !existsSync(gate)) await sleep(10);
			result = {
				tools: ["echo", "hidden", "guarded"].map((name) => ({
					name, description: `Docs ${name}.`, inputSchema,
				})),
			};
			break;
		case "tools/call":
			// `fail` makes a tool error that carries structured content.
			result = request.params.arguments.text === "fail"
				? { content: [{ type: "text", text: "docs: page not found" }], structuredContent: { code: 404 }, isError: true }
				: { content: [{ type: "text", text: `docs: ${request.params.arguments.text}` }] };
			break;
		case "resources/list":
			result = { resources: [page] };
			break;
		case "resources/read":
			result = { contents: [{ uri: request.params.uri, mimeType: page.mimeType, text: `# Intro (${request.params.uri})` }] };
			break;
		default:
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\n");
			continue;
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
