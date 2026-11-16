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
