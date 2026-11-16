# PRD: pi-ipython

## Problem

Pi's codemode runs each script in a fresh QuickJS sandbox. Data, helpers, and intermediate results do not survive between calls except as small JSON values in `store`/`load`. To keep working on large data across turns, the model has to re-read files or re-run tools, which costs tokens and round trips. The model also has to write JavaScript against host tool wrappers, when Python is the language it is strongest in for data and scripting work.

Unharnessed (and Prime Agent before it) puts a persistent Python REPL at the centre of the harness instead: the model sees one tool, `ipython`, and its Python state lives on between Cells and survives compaction. We want that model inside pi, as a pi extension, without forking pi.

## Goal

A pi package that, when loaded, turns the session into an Unharnessed-style harness: the model works only through a persistent Python **Kernel** (see `GLOSSARY.md`), and pi keeps handling the session, models, compaction, and UI.

## Non-goals

- Sandboxing. The Kernel runs with the user's permissions, as in Unharnessed.
- A real Jupyter/ipykernel. See `docs/adr/0001-rlm-runtime-not-ipykernel.md`.
- Running next to pi's other tools. The extension is exclusive by design.
- Recursive sub-agents (Prime's `rlm.spawn`) and Prime's continual-memory harness.

## Users

People who already run pi and want to try a Python-REPL-first agent on their own machine or in a container, without switching to the Unharnessed or Prime binaries.

## Requirements by release

### v1: Persistent Kernel

1. **Exclusive tool surface.** If the extension is loaded, `ipython` is the only active tool. All other tools, including extension tools like subagent and MCP, are hidden. It is turned on and off through pi profiles/settings.
2. **`ipython` tool.** Takes Python code, runs it as one Cell in the Kernel, and returns stdout, stderr, the repr of the trailing expression, any error with its traceback, and the duration.
3. **Persistent Kernel.** One Kernel per pi session, running `python -m rlm.repl`. The namespace is shared across Cells and top-level `await` works. The working directory is the session cwd.
4. **Lazy start.** The uv-managed venv is prepared in the background at `session_start`. The Kernel starts on the first Cell.
5. **Python environment.** A dedicated venv managed with uv, pinned to Python 3.13 by default and configurable. Optionally, the project's `.venv` can be used instead.
6. **Session lifecycle.** The Kernel is killed at `session_shutdown`. A new, resumed, or forked session gets a fresh Kernel, and the model is told that earlier Python state is gone.
7. **Branch switch (`/tree`).** The user is asked "Keep Kernel" or "Restart Kernel". With no UI, the Kernel is kept and the model gets a notice that Python state may not match the branch.
8. **Interrupt.** User abort sends an interrupt. If the Kernel is still busy when the next Cell arrives, the user chooses between waiting and killing the Kernel (which loses Python state).
9. **Python-state notice.** After every compaction while a Kernel is running, a `[python-state]` message lists the live names, taken from `list_names`.
10. **Output limits.** Pi's standard 50KB / 2000-line truncation. When output is cut, the full text is saved to a temp file and the result gives its path.
11. **Images.** `emit({"image/png": ...})` and other model-accepted image MIME types are returned as image content in the tool result.
12. **Background output.** Output not attributed to any Cell (asyncio tasks, threads, subprocesses) is buffered and attached to the next Cell's result under "background output".
13. **System prompt.** Pi's prompt is replaced by an Unharnessed-derived REPL prompt, plus AGENTS.md/context files, the skills list, cwd, and date. It must not suggest IPython magics or `!cmd`.
14. **Skills.** Markdown skills only. The model reads `SKILL.md` files with Python.
15. **Safety.** The README states plainly that there is no sandbox and recommends a container. An optional `confirmEachCell` setting asks the user before each Cell runs.
16. **TUI.** A simple renderer: highlighted Python code and truncated output.
17. **Config.** `~/.pi/agent/pi-ipython.json` (global) merged with `.pi/pi-ipython.json` (project); project values win. Keys: `confirmEachCell`, `python.source` (`uv` | `project`), `python.version`, output limits.

### v2: Survive restarts, background work

- `dill` snapshot/restore of Python state on resume and restart, with per-variable (16 MiB) and total (256 MiB) caps, and pruning of oversized names at compaction. Default caps follow Unharnessed.
- `bash()` handles that run in the background, and a wake-up message that starts a new turn when a handle finishes.
- Python skills: a skill with a `pyproject.toml` is installed into the Kernel venv and pre-imported.
- A full Cell renderer, ported from `ipython-cell.ts`.

### v3: MCP and goals

- MCP servers callable from Python (`mcp.search_tools`, `mcp.call_tool`), via the runtime's `mcp` module and `host_request`.
- Goal and autonomous continuation, following Unharnessed's semantics.

### v4: Pi bridge

- Python can call pi tools, for example `await pi.tool("subagent", {...})`, through `host_request`, subject to pi's tool hooks.

## Open questions (decide before v2)

- Snapshot semantics across branches, resume, and Kernel crash.
- The wording of the wake-up message, and the guard against wake-up loops.
- Whether to keep Unharnessed's 16 MiB/256 MiB caps.

## Success criteria for v1

- With the extension loaded, the model can load a file into a variable in one Cell and query it in a later Cell without re-reading it, including across a manual `/compact`.
- Aborting a long-running Cell interrupts it. A Kernel that stays wedged can be killed from the UI.
- Quitting pi leaves no orphan Kernel processes behind.
- The integration tests pass against a real Kernel.
