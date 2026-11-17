// Minimal stdio MCP server for real-session tests; no network or external packages.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const gate = process.argv[2];
const inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	switch (request.method) {
		case "initialize":
			result = {
				protocolVersion: request.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "test-docs", version: "1.0.0" },
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
			result = { content: [{ type: "text", text: `docs: ${request.params.arguments.text}` }] };
			break;
		default:
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\n");
			continue;
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
