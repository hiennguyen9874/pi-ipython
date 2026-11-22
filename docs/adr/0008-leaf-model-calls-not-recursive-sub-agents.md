# Cells may make leaf Model calls, not recursive sub-agents

The PRD rules out Prime's `rlm.spawn` (recursive sub-agents), yet the research behind RLM reports its largest gains where code hands semantically dense pieces to a model (OOLONG-Pairs: 4.8 with offloading alone vs 58–76 with RLM; draft, Reported claims). We allow a Cell to make Model calls: one request to a model with no tools and no Kernel of its own, so the call tree stays one level deep, cost stays boundable, and no second Kernel can leave partial state behind (ADR 0003). The feature is opt-in because every call costs money; its API, model selection, and budget are settled in #71.

## Considered Options

- **Recursive sub-agents (`rlm.spawn`)**: each child gets tools and a REPL. Rejected: depth > 1 helped clearly only on OOLONG-Pairs in the reported results, and cost and latency have a long tail.
- **Only `pi.tool("subagent", …)`**: works today when a subagent extension is loaded. Rejected as the only path: it depends on another extension, runs a full agent per call, and has no batch call or shared budget.
- **No model access from Cells**: keeps the scope smallest, but leaves out the one RLM idea with the strongest reported effect.
