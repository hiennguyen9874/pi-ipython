# Cells may make leaf Model calls, not recursive sub-agents

The PRD rules out Prime's `rlm.spawn` (recursive sub-agents), yet the research behind RLM reports its largest gains where code hands semantically dense pieces to a model (OOLONG-Pairs: 4.8 with offloading alone vs 58–76 with RLM; draft, Reported claims). We allow a Cell to make Model calls: one request to a model with no tools and no Kernel of its own, so the call tree stays one level deep, cost stays boundable, and no second Kernel can leave partial state behind (ADR 0003). The feature is opt-in because every call costs money; its API, model selection, and budget were settled in #71 (PRD v5).

## Considered Options

- **Recursive sub-agents (`rlm.spawn`)**: each child gets tools and a REPL. Rejected: depth > 1 helped clearly only on OOLONG-Pairs in the reported results, and cost and latency have a long tail.
- **Only `pi.tool("subagent", …)`**: works today when a subagent extension is loaded. Rejected as the only path: it depends on another extension, runs a full agent per call, and has no shared concurrency cap or budget.
- **No model access from Cells**: keeps the scope smallest, but leaves out the one RLM idea with the strongest reported effect.

## Consequences

- One function, `pi.ask(prompt, *, system=None) -> str`, and no batch function: the host caps Model calls at 8 in flight per Cell, so the model fans out with `asyncio.gather`, which it already knows. The glossary avoids "LLM call", so the API is not named `pi.llm`.
- The budget is a call count per Cell (`modelCalls.maxPerCell`), checked before sending, plus an output-token cap per call. USD is not used: cost is 0 or unknown for local, unpriced, and subscription models. Tokens cannot be checked before a call is sent.
- Usage goes on the `ipython` tool result's `usage`, which pi already adds to session totals, so no separate accounting exists.
- Model calls share the Bridged-call lifetime (the Cell's signal; nothing after the Cell ends) but raise their own `pi.ModelCallError`, because `pi.ToolError.result` has no meaning here.
- A configured model that cannot be resolved fails every call instead of falling back to the session model, which may cost more.
