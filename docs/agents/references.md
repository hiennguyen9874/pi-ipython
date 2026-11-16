# References

`references/` holds pinned, read-only git submodules. Read from them; edit only this repo's own code. If they are empty, run `git submodule update --init`.

| Submodule | Use it for |
|---|---|
| `references/Unharnessed` | The main source: the Kernel runtime (vendored), and the Kernel host from its pre-Rust history (ported) |
| `references/prime-agent` | Upstream of Unharnessed (same lineage). Its Prime-only features are out of scope: `rlm.spawn`, `harness.py`, `factory.py`, memory/refine |
| `references/howaboua-pi-stuff` | Prior art for a Kernel inside a pi extension (`packages/pi-codex-conversion/src/tools/notebook-mode/`). Its pure-TS Jupyter client matters only if ADR 0001 is revisited |

## Kernel runtime: vendor from Unharnessed HEAD

Source: `references/Unharnessed/unharnessed-runtime/src/rlm/`, vendored into `runtime/rlm/` together with its `test/` suite. The protocol spec is `repl.md` in the same folder (REPL protocol v3).

Vendor: `__init__.py`, `repl.py`, `bash.py`, `_winjob.py`, `variables.py`, `skill.py`, `mcp.py`, `mcp_base.py`, `repl.md`. `mcp` and `bash` are imported by `__init__` and the bootstrap cell, so they ship even before the features they back.

## Kernel host: port from pre-Rust history

Unharnessed's Rust core is a port of a TypeScript fork of pi. The last TS tree is commit `7d442aafa`, the parent of `39bc99a91` ("Port Prime Agent to Rust"). That code was written against pi internals, so porting it means adapting to pi's public extension API, not translating it.

Read it with `git -C references/Unharnessed show 7d442aafa:packages/coding-agent/src/<path>`. List files with `git -C references/Unharnessed ls-tree -r --name-only 7d442aafa`.

| File under `packages/coding-agent/src/` | Port into | Notes |
|---|---|---|
| `core/kernel/repl-manager.ts` | `src/kernel/` (Kernel client) | Spawn, JSONL framing, frame repair, interrupt, `list_names`, shutdown. Drop subagent/delegation paths. Snapshot paths stay dormant until v2 |
| `core/kernel/bootstrap.ts` | `src/kernel/` (bootstrap) | uv venv and dir lock. Replace `getPackageDir` with the package root. Python-skill install is v2 |
| `core/kernel/shared.ts`, `boot-gate.ts`, `state-snapshot.ts` | `src/kernel/` | Replace `registerSessionResourceCleanup` with `session_shutdown` |
| `core/tools/ipython.ts` | `src/tool/` | Rebuild on `pi.registerTool`. Keep result composition, the busy-Kernel choice, and the bootstrap cell |
| `core/prompts/rlm.ts` | `src/prompt/` | Remove the spawn, factory, and memory sections |
| `utils/child-process.ts`, `core/orphan-process-journal.ts` | `src/util/` | Only what orphan reaping needs |
| `modes/interactive/components/ipython-cell.ts` | `src/render/` | Full renderer, v2 |

Gotcha: comments in the TS host point to `prime-agent-runtime/src/rlm/repl.md`. Use Unharnessed's `unharnessed-runtime/src/rlm/repl.md` instead. Both use protocol v3.

## Rust at HEAD: a spec for later behaviour

Read the Rust only for behaviour added after the TS era:

- `crates/uh-core/src/session_engine/ipython_state.rs`: the Python-state notice after compaction.
- `crates/uh-core/src/kernel/manager/`: snapshot, repair, teardown.
- `crates/uh-core/src/tools/ipython.rs`: tool result text and the busy-Kernel choice.
- `crates/uh-core/src/prompts/layers/core.md`: the current REPL system prompt.

## Licensing

All three repos are MIT. Vendored and ported files keep their copyright headers (Unharnessed, Prime Intellect, Mario Zechner), and the repo NOTICE credits them.
