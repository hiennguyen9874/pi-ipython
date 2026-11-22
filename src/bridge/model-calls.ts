// Host side of Model calls (ADR 0008): `pi.ask` in `src/bridge/pi.py` sends the `pi.ask` host request answered here.

import { type Api, clampThinkingLevel, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiIpythonConfig } from "../config.ts";

export const PI_ASK_REQUEST = "pi.ask";

/** Model calls one Cell may have in flight; the rest wait for a slot. Fixed, not configurable (#71). */
export const MAX_MODEL_CALLS_IN_FLIGHT = 8;

type ModelCallsConfig = PiIpythonConfig["modelCalls"];
type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry">;

const ENDED_ERROR = "Model calls are only allowed while their originating Cell runs";
const ABORTED_ERROR = "Model call aborted";

/**
 * The model Model calls use: `modelCalls.model` (exact `provider/id`), else the session's current model.
 * A string is why there is none. A configured model never falls back to the session's, which may cost more.
 */
export function resolveModelCallModel(config: ModelCallsConfig, ctx: ModelContext): Model<Api> | string {
	let model: Model<Api> | undefined;
	if (config.model === undefined) {
		model = ctx.model;
		if (!model) return "No model is selected for Model calls";
	} else {
		const slash = config.model.indexOf("/");
		model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
		if (!model) return `Model ${config.model} (modelCalls.model) not found`;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) return `No credentials for ${model.provider}/${model.id}, the model for Model calls`;
	return model;
}

/** What a Cell's Model calls cost so far, for the TUI. */
export interface ModelCallsSummary {
	/** Model calls sent to the model, including those still in flight. */
	count: number;
	totalTokens: number;
	/** In USD; 0 when the model is free or unpriced. */
	cost: number;
}

/**
 * One Cell's Model calls: at most `MAX_MODEL_CALLS_IN_FLIGHT` in flight, at most `modelCalls.maxPerCell` sent,
 * and their usage summed. `close()` when the Cell's tool call returns: calls still in flight are aborted, and later
 * calls fail without sending.
 */
export class CellModelCalls {
	/** The summed usage of every Model call this Cell got a reply to, or undefined before the first. */
	usage: Usage | undefined;
	/** Calls sent to the model, including those still in flight. */
	private count = 0;
	private sent = 0;
	private inFlight = 0;
	private readonly waiting: (() => void)[] = [];
	private readonly controller = new AbortController();
	private closed = false;
	private readonly onAbort = () => this.controller.abort();

	constructor(
		private readonly getConfig: () => ModelCallsConfig,
		private readonly ctx: ModelContext,
		/** The Cell's signal: Esc aborts its Model calls. */
		private readonly cellSignal: AbortSignal | undefined,
		/** Called when `summary()` changes. */
		private readonly onChange: () => void = () => {},
	) {
		if (cellSignal?.aborted) this.controller.abort();
		else cellSignal?.addEventListener("abort", this.onAbort, { once: true });
	}

	/** The Cell's Model calls so far, or undefined before the first is sent. */
	summary(): ModelCallsSummary | undefined {
		if (this.count === 0) return undefined;
		return { count: this.count, totalTokens: this.usage?.totalTokens ?? 0, cost: this.usage?.cost.total ?? 0 };
	}

	close(): void {
		this.closed = true;
		this.cellSignal?.removeEventListener("abort", this.onAbort);
		this.controller.abort();
	}

	/** Answer one `pi.ask` request with the answer text; rejects with the text `pi.ModelCallError` carries. */
	async ask(data: Record<string, unknown>): Promise<string> {
		const config = this.getConfig();
		if (!config.enabled) throw new Error("Model calls are turned off (modelCalls.enabled: false)");
		const { prompt, system } = data;
		if (typeof prompt !== "string" || prompt === "") throw new Error("prompt must be a non-empty string");
		if (system !== undefined && system !== null && typeof system !== "string") throw new Error("system must be a string");
		this.checkOpen();
		const model = resolveModelCallModel(config, this.ctx);
		if (typeof model === "string") throw new Error(model);
		if (this.sent >= config.maxPerCell) {
			throw new Error(`Model call limit reached: at most ${config.maxPerCell} per Cell (modelCalls.maxPerCell)`);
		}
		this.sent++;
		await this.acquire();
		try {
			this.checkOpen();
			const thinking = clampThinkingLevel(model, config.thinking);
			const maxTokens = Math.min(config.maxOutputTokens, model.maxTokens);
			// Budget-based reasoning adapters add thinking tokens, up to the model ceiling.
			const requestModel = thinking !== "off" && maxTokens < model.maxTokens ? { ...model, maxTokens } : model;
			const stream = this.ctx.modelRegistry.streamSimple(
				requestModel,
				{ ...(system ? { systemPrompt: system } : {}), messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				{
					signal: this.controller.signal,
					maxTokens,
					...(thinking === "off" ? {} : { reasoning: thinking }),
				},
			);
			this.count++;
			this.onChange();
			const message = await stream.result();
			this.usage = this.usage ? addUsage(this.usage, message.usage) : message.usage;
			this.onChange();
			if (message.stopReason === "aborted") throw new Error(message.errorMessage || ABORTED_ERROR);
			if (message.stopReason === "error") throw new Error(message.errorMessage || "Model call failed");
			// The answer text only: thinking parts are dropped.
			return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		} finally {
			this.release();
		}
	}

	private checkOpen(): void {
		if (this.closed) throw new Error(ENDED_ERROR);
		if (this.controller.signal.aborted) throw new Error(ABORTED_ERROR);
	}

	/** Wait for an in-flight slot; rejects if the Cell is aborted or ends first. */
	private acquire(): Promise<void> {
		if (this.inFlight < MAX_MODEL_CALLS_IN_FLIGHT) {
			this.inFlight++;
			return Promise.resolve();
		}
		const signal = this.controller.signal;
		return new Promise((resolve, reject) => {
			const grant = () => {
				signal.removeEventListener("abort", cancel);
				resolve();
			};
			const cancel = () => {
				this.waiting.splice(this.waiting.indexOf(grant), 1);
				reject(new Error(this.closed ? ENDED_ERROR : ABORTED_ERROR));
			};
			this.waiting.push(grant);
			signal.addEventListener("abort", cancel, { once: true });
		});
	}

	/** Hand the slot to the next waiting call, or free it. */
	private release(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.inFlight--;
	}
}

/** The sum of two usages, by the same rules as pi's `combineUsage` (not exported). */
function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined
			? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) }
			: {}),
		...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
			// A sum is provider-reported only when every part is.
			totalFromProvider: a.cost.totalFromProvider === true && b.cost.totalFromProvider === true,
		},
	};
}
