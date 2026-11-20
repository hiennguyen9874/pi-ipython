# Implementation plan: pi-ipython

The product requirements are in `docs/prd.md`. Terms are defined in `GLOSSARY.md`. The runtime choice is recorded in `docs/adr/0001-rlm-runtime-not-ipykernel.md`.

## Code sources

What to vendor, what to port, and from which commit: `docs/agents/references.md`.

## Target layout

```
package.json            # pi package manifest (extension entry)
src/
  index.ts              # extension entry: wires everything to pi events
  config.ts             # global + project JSON config merge
  kernel/               # bootstrap (uv venv), kernel-client (protocol), lifecycle
  tool/ipython-tool.ts  # registerTool, result shaping, truncation, images
  prompt/               # sections inserted into pi's system prompt
  session/              # lifecycle hooks: start, shutdown, tree, compact notice
  render/               # simple TUI renderer
runtime/rlm/            # vendored Kernel runtime + pyproject.toml
test/                   # vitest integration tests (real Kernel)
```

## Pi integration points

| Need | Pi API |
|---|---|
| Register the tool and make it exclusive | `pi.registerTool`, `pi.setActiveTools(["ipython"])` (also enforced in `before_agent_start` through `systemPromptOptions.selectedTools`) |
| Extend the system prompt (#24, ADR 0005) | `before_agent_start` → insert `<ipython>` and `<skills>` into `event.systemPrompt` and return it as `systemPrompt`; the `pi` section goes in the `ipython` description via `prepareLoadout` |
| Venv warm-up | `session_start` |
| Kill the Kernel | `session_shutdown` (all reasons) |
| Branch switch prompt | `session_tree` + `ctx.ui` select (`ctx.hasUI` false → keep Kernel and notify) |
| Python-state notice | `session_compact` → `pi.sendMessage({customType: "ipython_state", ...})` |
| State-lost notice | `session_start` with reason `resume`/`fork`/`new` → `pi.sendMessage` (`deliverAs: "nextTurn"`) |
| Abort / interrupt | tool `execute(signal)` → protocol `interrupt` |
| Busy Kernel / confirm each Cell | `ctx.ui` select/confirm inside `execute` |
| Truncation | pi output truncation helpers, with full output written to a Spill file |
| Rendering | `renderCall` / `renderResult` on the tool definition |
| Bridged calls (v3) | `ctx.executeTool` inside the running Cell's `execute`, answering the Kernel's `host_request` |
| Callable set (v3) | activate bridged `direct` tools alongside `ipython` and hide their declarations via `prepareLoadout` → `hiddenDeclarations`; `pi.getAllTools()` for discovery |

## v1 slices (each one demoable)

1. **Package skeleton and vendored runtime.** Pi package manifest, extension entry, `runtime/rlm/` vendored with its pytest suite passing under uv.
2. **Kernel client.** Port `repl-manager.ts`: spawn, the `ready` handshake, execute, event routing (stdout/stderr/result/display/error/done), interrupt, `list_names`, shutdown, frame repair. Tested with vitest against a real Kernel.
3. **Venv bootstrap.** uv venv with Python 3.13 (configurable) and the project-`.venv` option, warmed at `session_start`, Kernel started lazily.
4. **`ipython` tool, end to end.** Register the tool, make it exclusive, shape results (stdout, stderr, result, error, duration), apply truncation with the temp-file path.
5. **Config loading.** Global and project JSON merge, the documented keys, and validation errors shown in the UI.
6. **System prompt.** Unharnessed-derived REPL guidance and skills list extend pi's prompt (#24, ADR 0005), preserving pi's context files and cwd.
7. **Session lifecycle.** Kill on shutdown, state-lost notice on new/resume/fork, no orphan processes (orphan journal).
8. **Branch switch handling.** The keep/restart prompt on `/tree`, with a no-UI fallback.
9. **Interrupt and busy Kernel.** Abort → interrupt. A still-busy Kernel → a wait-or-kill choice.
10. **Python-state notice after compaction.**
11. **Images and background output.** `emit` image MIME → image content. Unattributed output attached to the next result.
12. **`confirmEachCell` and README safety section.**
13. **Simple TUI renderer.**

## Later releases (one parent ticket each, broken down when they start)

- **v1.1 (#16):** harden the Kernel contract. v3 may proceed in parallel.
- **v2 (#13):** snapshot/restore (no live pruning, ADR 0002), opt-in background-command notices, full renderer; Python skills deferred.
- **v3 (#15):** pi tool bridge through `host_request` and `ctx.executeTool` (see `docs/prd.md`).
- **v4 (#14):** MCP through the bridge; pi's MCP tools are plain Pi tools. Goals and autonomous mode are not planned (#29).

## Testing

- **vitest** integration tests that start a real Kernel, covering the protocol client, the tool, and lifecycle. Pi APIs are faked at the extension seam.
- **pytest** for the vendored runtime, keeping Unharnessed's tests.
- A manual smoke test inside pi for each slice that touches the UI.
