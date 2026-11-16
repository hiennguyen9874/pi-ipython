# Kernel runtime is Unharnessed's `rlm` over JSONL, not ipykernel

The model-facing tool is called `ipython`, but the Kernel is a plain CPython REPL (`python -m rlm.repl`, vendored from Unharnessed) speaking newline-delimited JSON over stdio, not an IPython/ipykernel process speaking the Jupyter wire protocol. We chose it because it already provides what an agent host needs: per-Cell output attribution, interrupt semantics, a `host_request` bridge back to the host, and `dill` snapshot/restore. A pre-Rust TypeScript host for it also exists in Unharnessed's git history (`7d442aafa`, built on pi's own codebase), so we can port that code instead of writing it.

## Considered Options

- **ipykernel via Jupyter wire** (reusing howaboua's pure-TS ZMTP client): gives IPython magics, `!cmd`, and rich display, but the host bridge (via comms), snapshots, and background bash would all have to be rebuilt.
- **`rlm` protocol with IPython `InteractiveShell` inside**: gives magics without changing the host. Kept as a possible later upgrade.

## Consequences

IPython-only syntax (`%magic`, `!cmd`) does not work in Cells. The system prompt must not suggest it.
