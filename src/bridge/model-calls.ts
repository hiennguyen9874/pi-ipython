// Host side of Model calls (ADR 0008): `pi.ask` and `pi.classify` in `src/bridge/pi.py` send the host requests
// answered here.

import {
	type Api,
	type ClassifierAnswer,
	type ClassifierApi,
	type ClassifierModel,
	type ClassifierQuestion,
	clampThinkingLevel,
	type JsonObject,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiIpythonConfig } from "../config.ts";

export const PI_ASK_REQUEST = "pi.ask";
export const PI_CLASSIFY_REQUEST = "pi.classify";

/** Model calls one Cell may have in flight; the rest wait for a slot. Fixed, not configurable (#71). */
export const MAX_MODEL_CALLS_IN_FLIGHT = 8;

type ModelCallsConfig = PiIpythonConfig["modelCalls"];
type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry">;

/** What `CellModelCalls` needs from any kind of Model call's reply. */
interface ModelReply {
	usage?: Usage;
	stopReason: string;
	errorMessage?: string;
}

const ENDED_ERROR = "Model calls are only allowed while their originating Cell runs";
const ABORTED_ERROR = "Model call aborted";

/**
 * The chat model `pi.ask` uses: `modelCalls.model` (exact `provider/id`), else the session's current model.
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

/**
 * The classifier `pi.classify` uses: `modelCalls.classifier` (exact `provider/id`). A string is why there is none.
 * There is no default: unset, no data reaches a classifier the user did not choose.
 */
export function resolveClassifier(
	config: ModelCallsConfig,
	registry: ModelContext["modelRegistry"],
): ClassifierModel<ClassifierApi> | string {
	if (config.classifier === undefined) return "No classifier is set for Model calls (modelCalls.classifier)";
	const slash = config.classifier.indexOf("/");
	const model = registry.findOfType("classifier", config.classifier.slice(0, slash), config.classifier.slice(slash + 1));
	if (!model) return `Classifier ${config.classifier} (modelCalls.classifier) not found`;
	// The check reads only the model's provider, so it applies to a classifier as to a chat model.
	if (!registry.hasConfiguredAuth(model as unknown as Model<Api>)) {
		return `No credentials for ${model.provider}/${model.id}, the classifier for Model calls`;
	}
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
		const config = this.enabledConfig();
		const { prompt, system } = data;
		if (typeof prompt !== "string" || prompt === "") throw new Error("prompt must be a non-empty string");
		if (system !== undefined && system !== null && typeof system !== "string") throw new Error("system must be a string");
		const message = await this.call(
			config,
			() => resolveModelCallModel(config, this.ctx),
			(model, signal) => {
				const thinking = clampThinkingLevel(model, config.thinking);
				const maxTokens = Math.min(config.maxOutputTokens, model.maxTokens);
				// Budget-based reasoning adapters add thinking tokens, up to the model ceiling.
				const requestModel = thinking !== "off" && maxTokens < model.maxTokens ? { ...model, maxTokens } : model;
				return this.ctx.modelRegistry
					.streamSimple(
						requestModel,
						{ ...(system ? { systemPrompt: system } : {}), messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
						{ signal, maxTokens, ...(thinking === "off" ? {} : { reasoning: thinking }) },
					)
					.result();
			},
		);
		if (message.stopReason === "length") {
			throw new Error("Model answer truncated at the output limit; request a shorter answer or split the input");
		}
		// The answer text only: thinking parts are dropped.
		return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	}

	/** Answer one `pi.classify` request with the answers by question ID; rejects with the text `pi.ModelCallError` carries. */
	async classify(data: Record<string, unknown>): Promise<Record<string, ClassifierAnswer>> {
		const config = this.enabledConfig();
		const { state, questions } = data;
		if (!isPlainObject(state)) throw new Error("state must be an object");
		if (!isPlainObject(questions) || Object.keys(questions).length === 0) throw new Error("questions must be a non-empty object");
		// Question shapes are left to pi and the provider: a bad one comes back as an error result.
		const result = await this.call(
			config,
			() => resolveClassifier(config, this.ctx.modelRegistry),
			(model, signal) =>
				this.ctx.modelRegistry.classify(
					model,
					{ state: state as JsonObject, questions: questions as Record<string, ClassifierQuestion> },
					{ signal },
				),
		);
		if (result.stopReason !== "stop") throw new Error(result.errorMessage || "Model call failed");
		return result.answers;
	}

	/** The Model calls config, or why Model calls cannot be made at all. */
	private enabledConfig(): ModelCallsConfig {
		const config = this.getConfig();
		if (!config.enabled) throw new Error("Model calls are turned off (modelCalls.enabled: false)");
		return config;
	}

	/**
	 * The steps every kind of Model call shares, after its arguments are checked: fail if the Cell ended or was
	 * aborted, `prepare` what the request needs (its model and anything else that can fail before the call counts;
	 * a string is why it cannot be made), count the call against `modelCalls.maxPerCell`, wait for an in-flight
	 * slot, then `send` it and sum its usage. Resolves to the reply, unless it was aborted or failed.
	 */
	private async call<P, R extends ModelReply>(
		config: ModelCallsConfig,
		prepare: () => P | string | Promise<P | string>,
		send: (prepared: P, signal: AbortSignal) => Promise<R>,
	): Promise<R> {
		this.checkOpen();
		const prepared = await prepare();
		if (typeof prepared === "string") throw new Error(prepared);
		if (this.sent >= config.maxPerCell) {
			throw new Error(`Model call limit reached: at most ${config.maxPerCell} per Cell (modelCalls.maxPerCell)`);
		}
		this.sent++;
		await this.acquire();
		try {
			this.checkOpen();
			const pending = send(prepared, this.controller.signal);
			this.count++;
			this.onChange();
			const reply = await pending;
			// A reply without usage still counts in the summary, with 0 tokens and $0.
			if (reply.usage) this.usage = this.usage ? addUsage(this.usage, reply.usage) : reply.usage;
			this.onChange();
			if (reply.stopReason === "aborted") throw new Error(reply.errorMessage || ABORTED_ERROR);
			if (reply.stopReason === "error") throw new Error(reply.errorMessage || "Model call failed");
			return reply;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
