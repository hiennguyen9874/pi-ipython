# Implementation plan: pi-ipython

The product requirements are in `docs/prd.md`. Terms are defined in `GLOSSARY.md`. The runtime choice is recorded in `docs/adr/0001-rlm-runtime-not-ipykernel.md`.

## Code sources

| What | From | License |
|---|---|---|
| Kernel runtime (`rlm` package) | `references/Unharnessed/unharnessed-runtime/src/rlm/` at HEAD `fe2cf281` | MIT (Unharnessed, Prime Intellect, Mario Zechner) |
| Kernel host (TS) | `references/Unharnessed` at commit `7d442aafa` (the parent of "Port Prime Agent to Rust", `39bc99a91`), under `packages/coding-agent/src/` | MIT |
| Spec for behaviour added after the TS era | Rust crates at HEAD: `uh-core/src/session_engine/ipython_state.rs`, `uh-core/src/kernel/manager/*`, `uh-core/src/tools/ipython.rs`, `uh-core/src/prompts/layers/core.md` | MIT |

Read the files from history with `git -C references/Unharnessed show 7d442aafa:<path>`. Both the TS host and the HEAD runtime use REPL protocol **v3**.

Files to port from `7d442aafa:packages/coding-agent/src/`:

| File | Lines | Port into | Notes |
|---|---|---|---|
| `core/kernel/repl-manager.ts` | 1817 | `src/kernel/kernel-client.ts` | Spawning, JSONL framing, frame validation and repair, interrupt, `list_names`, shutdown. Drop subagent/delegation paths. Snapshot paths stay dormant until v2. |
| `core/kernel/bootstrap.ts` | 1037 | `src/kernel/bootstrap.ts` | uv venv creation and dir lock. Swap `getPackageDir` for the package root. Python-skill install waits for v2. |
| `core/kernel/shared.ts`, `boot-gate.ts`, `state-snapshot.ts` | ~420 | `src/kernel/` | Swap `registerSessionResourceCleanup` for `session_shutdown`. |
| `core/tools/ipython.ts` | 770 | `src/tool/ipython-tool.ts` | Rewrite against `pi.registerTool`. Keep result composition, the busy-kernel choice, and the bootstrap cell. |
| `core/prompts/rlm.ts` + `core.md` | ~260 | `src/prompt/` | Remove spawn, factory, and Prime memory sections. |
| `utils/child-process.ts`, `orphan-process-journal.ts` | n/a | `src/util/` | Only the parts needed for orphan reaping. |

Runtime files to vendor into `runtime/rlm/`: `__init__.py`, `repl.py`, `bash.py`, `_winjob.py`, `variables.py`, `skill.py`, `mcp.py`, `mcp_base.py`, plus `repl.md` and the `test/` suite. `mcp`/`bash` are imported by `__init__` and the bootstrap cell, so they ship in v1 even though the features they back come in later releases.

## Target layout

```
package.json            # pi package manifest (extension entry)
src/
  index.ts              # extension entry: wires everything to pi events
  config.ts             # global + project JSON config merge
  kernel/               # bootstrap (uv venv), kernel-client (protocol), lifecycle
  tool/ipython-tool.ts  # registerTool, result shaping, truncation, images
  prompt/               # forced system prompt builder
  session/              # lifecycle hooks: start, shutdown, tree, compact notice
  render/               # simple TUI renderer
runtime/rlm/            # vendored Kernel runtime + pyproject.toml
test/                   # vitest integration tests (real Kernel)
```

## Pi integration points

| Need | Pi API |
|---|---|
| Register the tool and make it exclusive | `pi.registerTool`, `pi.setActiveTools(["ipython"])` (also enforced in `before_agent_start` through `systemPromptOptions.selectedTools`) |
| Replace the system prompt | `before_agent_start` → `forceSystemPrompt`, built from `systemPromptOptions.contextFiles`, `.skills`, `.cwd` |
| Venv warm-up | `session_start` |
| Kill the Kernel | `session_shutdown` (all reasons) |
| Branch switch prompt | `session_tree` + `ctx.ui` select (`ctx.hasUI` false → keep Kernel and notify) |
| Python-state notice | `session_compact` → `pi.sendMessage({customType: "ipython_state", ...})` |
| State-lost notice | `session_start` with reason `resume`/`fork`/`new` → `pi.sendMessage` (`deliverAs: "nextTurn"`) |
| Abort / interrupt | tool `execute(signal)` → protocol `interrupt` |
| Busy Kernel / confirm each Cell | `ctx.ui` select/confirm inside `execute` |
| Truncation | pi output truncation helpers, with full output written to a temp file |
| Rendering | `renderCall` / `renderResult` on the tool definition |

## v1 slices (each one demoable)

1. **Package skeleton and vendored runtime.** Pi package manifest, extension entry, `runtime/rlm/` vendored with its pytest suite passing under uv.
2. **Kernel client.** Port `repl-manager.ts`: spawn, the `ready` handshake, execute, event routing (stdout/stderr/result/display/error/done), interrupt, `list_names`, shutdown, frame repair. Tested with vitest against a real Kernel.
3. **Venv bootstrap.** uv venv with Python 3.13 (configurable) and the project-`.venv` option, warmed at `session_start`, Kernel started lazily.
4. **`ipython` tool, end to end.** Register the tool, make it exclusive, shape results (stdout, stderr, result, error, duration), apply truncation with the temp-file path.
5. **Config loading.** Global and project JSON merge, the documented keys, and validation errors shown in the UI.
6. **System prompt replacement.** Unharnessed-derived prompt plus context files, skills list, cwd, and date.
7. **Session lifecycle.** Kill on shutdown, state-lost notice on new/resume/fork, no orphan processes (orphan journal).
8. **Branch switch handling.** The keep/restart prompt on `/tree`, with a no-UI fallback.
9. **Interrupt and busy Kernel.** Abort → interrupt. A still-busy Kernel → a wait-or-kill choice.
10. **Python-state notice after compaction.**
11. **Images and background output.** `emit` image MIME → image content. Unattributed output attached to the next result.
12. **`confirmEachCell` and README safety section.**
13. **Simple TUI renderer.**

## Later releases (one parent ticket each, broken down when they start)

- **v2:** snapshot/restore and pruning, `bash()` wake-ups, Python skills, full renderer. Starts with a grilling session on the open questions in the PRD.
- **v3:** MCP in the Kernel, goals and autonomous mode.
- **v4:** pi tool bridge through `host_request`.

## Testing

- **vitest** integration tests that start a real Kernel, covering the protocol client, the tool, and lifecycle. Pi APIs are faked at the extension seam.
- **pytest** for the vendored runtime, keeping Unharnessed's tests.
- A manual smoke test inside pi for each slice that touches the UI.
