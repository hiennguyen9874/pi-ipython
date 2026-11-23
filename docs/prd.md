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
- Recursive sub-agents (Prime's `rlm.spawn`) and Prime's continual-memory harness. Leaf Model calls are in scope instead (v5, ADR 0008).
- Cells that return before they finish (Unreal Agent's "still running" tool result). The Kernel runs one Cell at a time, so the next Cell would wait anyway, and a Cell cut loose from its call risks the partial-state problems of ADR 0003. Long work goes in `bash()` handles (Background commands) instead.

## Users

People who already run pi and want to try a Python-REPL-first agent on their own machine or in a container, without switching to the Unharnessed or Prime binaries.

## Requirements by release

### v1: Persistent Kernel

1. **Exclusive tool surface.** If the extension is loaded, `ipython` is the only active tool. All other tools, including extension tools like subagent and MCP, are hidden from the model (from v3, Cells can still call them through the pi tool bridge). It is turned on and off through pi profiles/settings.
2. **`ipython` tool.** Takes Python code, runs it as one Cell in the Kernel, and returns stdout, stderr, the repr of the trailing expression, any error with its traceback, and the duration.
3. **Persistent Kernel.** One Kernel per pi session, running `python -m rlm.repl`. The namespace is shared across Cells and top-level `await` works. The working directory is the session cwd.
4. **Lazy start.** The uv-managed venv is prepared in the background at `session_start`. The Kernel starts on the first Cell.
5. **Python environment.** A dedicated venv managed with uv, pinned to Python 3.13 by default and configurable. Optionally, the project's `.venv` can be used instead.
6. **Session lifecycle.** The Kernel is killed at `session_shutdown` and starts lazily in the next session. Resume and fork always send the model a hidden State-loss notice; other starts do so when the branch has earlier Cell results or summaries. A clean `/new` sends no notice. Summaries are treated conservatively because they can refer to state from another branch.
7. **Branch switch (`/tree`).** The user is asked "Keep Kernel" or "Restart Kernel". With no UI, the Kernel is kept and the model gets a notice that Python state may not match the branch.
8. **Interrupt.** User abort sends an interrupt. If the Kernel is still busy when the next Cell arrives, the user chooses between waiting and killing the Kernel (which loses Python state).
9. **Python-state notice.** After every compaction while a Kernel is running, a `[python-state]` message lists up to 50 eligible live names from `list_names`, within 2,000 UTF-16 code units overall. It identifies omitted names and filtering, or reports when listing fails.
10. **Output limits.** Pi's standard 50KB / 2000-line truncation. When output is cut, the full text is saved to a Spill file and the result gives its path.
11. **Images.** `emit({"image/png": ...})` and other model-accepted image MIME types are returned as image content. Each result keeps at most the last eight images, including Background displays. Images that cannot be fitted to pi's size limit are dropped, with a notice.
12. **Background output.** Output not attributed to any Cell (asyncio tasks, threads, subprocesses) is buffered and attached to the next Cell's result under "background output".
13. **System prompt.** Pi's prompt is extended, not replaced (#24, ADR 0005): an Unharnessed-derived `<ipython>` section goes before `<docs>` by default (or before the first of `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`, else at the end). Its placement can be configured (#55). A `<skills>` section, which pi leaves out because no file-reading tool is active, goes before `<cwd>`. `SYSTEM.md`, `APPEND_SYSTEM.md`, context files, cwd, and other extensions' changes to `event.systemPrompt` are kept. No date. It must not suggest IPython magics or `!cmd`.
14. **Skills.** Markdown skills only. The model reads `SKILL.md` files with Python.
15. **Safety.** The README states plainly that there is no sandbox and recommends a container. An optional `confirmEachCell` setting asks the user before each Cell runs.
16. **TUI.** A simple renderer: highlighted Python code and truncated output.
17. **Config.** `~/.pi/agent/pi-ipython.json` (global) merged with `.pi/pi-ipython.json` (project); project values win. Keys: `confirmEachCell`, `python.source` (`uv` | `project`), `python.version`, output limits, `piTools.list` and `piTools.search` (both default `true`, v3), `python.defaultPackages` and `python.packages` (Kernel packages, uv only; see #48 and ADR 0004), and `systemPrompt.ipythonAfter` / `systemPrompt.ipythonBefore` (section anchors, #55), and `modelCalls.*` (v5, #71).

### v1.1: Harden the Kernel contract (#16)

- A State-loss notice on every Kernel replacement, including crashes; bounded host memory for output; a minimal bootstrap namespace; a bounded Python-state notice; compaction-summary guidance; live output streaming; a documented system prompt customization contract. No new model-facing abstractions.

### v2: Survive restarts, background work (#13)

- `dill` snapshot/restore of Python state on resume and restart, per session. Caps (Unharnessed: 16 MiB per name, 256 MiB total) only limit what is saved; compaction never removes live Python state (ADR 0002).
- `bash()` handles that run in the background, and a notice, on by default in TUI and RPC, that starts a new turn when a handle finishes.
- Python skills: deferred until a concrete need appears.
- A full Cell renderer, ported from `ipython-cell.ts`.

### v3: Pi tool bridge (#15)

Can ship in parallel with v1.1; it does not wait for #16.

- **Bridged calls.** `await pi.tool(name, args)` calls a Pi tool through `host_request` and pi's `ctx.executeTool`, so validation, `tool_call`/`tool_result` hooks, and permission checks apply as for model-issued calls. Async only.
- **Callable set.** Every registered Pi tool except `hidden` ones, `ipython` itself, tools that reach other tools (`codemode`, `tool_search`, anything with `reachesTools`), and pi's built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). The model still sees only `ipython`. The set is recomputed every turn; `pi.tools()` reads it live. No config.
- **Discovery.** `pi.tools()` lists `{name, description, namespace}` (first description line). `pi.describe(name)` gives the full description, the JSON schema of the arguments, the tool's prompt guidelines, and `returns` (the output schema, or `"str"` for tools without one). `pi.describe_namespace(name)` gives a namespace's description and instructions, for example an MCP server's instructions. `pi.search(query, limit=8, namespace=None)` ranks every callable tool with BM25 (ported from pi's tool search) and returns entries shaped like `pi.tools()`; with `namespace` (name or alias, as `pi.describe_namespace`) it filters to that namespace first, ranks inside it, then applies `limit`, and a namespace with no callable tools raises `pi.ToolError`; `piTools.search: false` turns it off. The `ipython` description (set in `prepareLoadout`, which pi calls whenever the tools change) mentions `pi` and how to discover tools only when the live callable set is nonempty, and mentions `pi.describe_namespace` and `pi.search` only inside that section (`pi.search` only while it is on). That section ends by telling the model to call `pi.describe(name)` before first using a tool, since the listing shows only names and first description lines. The system prompt never mentions `pi` (#24). Without callable Pi tools the description is exactly as without these features. Pending MCP servers with no registered callable tools do not add instructions.
- **Listed Pi tools.** Like codemode, the `ipython` description (set in `prepareLoadout`) lists callable tools with `direct` or `codemode` exposure: the name and first description line, grouped by namespace, within a fixed budget of 3000 estimated tokens shared round-robin across namespaces. A namespace that does not fit is marked `(some tools not listed)` or `(tools not listed)`. `deferred` tools, which include MCP tools by default, are never listed, so MCP servers connecting change the description only when they make the callable set nonempty (the `pi` section above). With no callable `direct` or `codemode` tool (no extension tools, or only `deferred` MCP tools) the list is left out. `piTools.list: false` turns the list off, with the same result.
- **Results.** As in codemode: `structuredContent` (a dict) when the tool declares `outputSchema`, otherwise the text content as one `str`. Any error outcome raises `pi.ToolError` (a `RuntimeError`) with the tool's error text; its `result` is the error result's `structuredContent` dict when the tool declares `outputSchema` and the result carries it, else `None` (always `None` for hook blocks, invalid arguments, unknown tools, and calls after the Cell finished). Images are not returned; the text ends with `[N image(s) omitted]`.
- **MCP resources.** Already callable through `pi.tool`, with no separate API; see v4 below for resource discovery, exposure, and hidden-server behavior.
- **Lifetime.** A Bridged call is allowed only while its Cell's `ipython` call is running and uses that call's signal, so interrupting the Cell aborts it. Calls from background tasks or threads after the Cell returned fail at once. Concurrent calls within one Cell are allowed.
- **Safety.** No extra confirmation per Bridged call; `confirmEachCell` covers the Cell, and pi's hooks guard each call. Documentation says Bridged calls can be hooked but direct Python is still not sandboxed.
- **Namespace.** `pi` is a module owned by this repo (the vendored runtime stays unchanged), bound by the bootstrap in every new Kernel and left out of the Python-state notice.
- **TUI.** pi's default display of nested tool calls; the Cell renderer is unchanged.

### v4: MCP via the bridge (#14)

- MCP servers callable from Python through the pi tool bridge and pi's own MCP support, not a separate Python MCP stack. pi's MCP tools (`codemode` exposure by default) are plain Pi tools to the bridge; the runtime's `rlm.mcp` API is not revived.
- MCP resources need no API of their own: `builtin:mcp`'s `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` do not declare `reachesTools`, so they are in the callable set and return their JSON payloads as dicts. pi registers them with the widest exposure of the non-`hidden` servers with resources (so `deferred` by default: not listed, but found by `pi.tools()` and `pi.search`), makes them wait for every ready server, and never lets them reach `hidden` servers. With no such server they are not registered.
- Goals and autonomous continuation are not planned for core (#29).

### v5: Model calls and guardrails

- **Model calls** (`GLOSSARY.md`, ADR 0008, settled in #71). Can ship in parallel with #25.
  - **API.** `await pi.ask(prompt, *, system=None, images=None)` returns the answer text as one `str` (thinking parts dropped). No JSON-schema output, message history, or per-call model for `pi.ask`. **Images** (#85): `images=[...]` takes the same values as `pi.classify`'s, encoded and detected the same way, and sends them in list order before the prompt text in one user message. Images for a model whose `input` lacks `"image"` (checked against the model resolved at call time) raise `pi.ModelCallError` before counting or sending; `images=[]` works on any model. One call is one Model call however many images it carries. Both APIs are async. The host keeps at most 8 Model calls in flight per Cell and queues the rest, so the model fans out with `asyncio.gather`.
  - **Classifier** (#79, part of #77). `await pi.classify(state, questions)` takes a JSON-serializable dict and a non-empty dict of pi's bool, choice, or score questions. It returns pi's answers by question ID, unchanged. Python checks the arguments, not the individual question shapes. **Images** (#80, #81): `await pi.classify(state, questions, images=[...])` accepts a mixed list of paths (`str`/`os.PathLike`), bytes-like values (`bytes`, `bytearray`, `memoryview`), and Pillow images. The Kernel resolves paths against its current cwd and base64-encodes bytes. It detects Pillow images only if `PIL.Image` is already loaded and encodes them as PNG, converting unsupported modes to RGB or RGBA without resizing. The host reads files and detects PNG/JPEG/WebP/GIF from content, with no MIME parameter, resizing, size limit, or path restrictions; provider limits apply. Non-list images or unsupported item types raise `TypeError`. Unreadable/missing files, unsupported formats, or images for a classifier without image input raise `pi.ModelCallError` before counting or sending. `modelCalls.classifier` selects an exact `provider/id` from pi's classifier models, with no default or fallback. When Model calls are enabled, an unresolved or credential-less configured classifier warns at `session_start`. Missing or unusable classifiers fail without spending budget. Each request to pi's registry counts as one Model call, with usage added even on provider errors when available.
  - **Model.** `modelCalls.model` (exact `provider/id`, no fuzzy match); unset means the session's current model at call time. It need not be in `enabledModels`. If it is not found or has no auth, the user is warned at `session_start` and every `pi.ask` call fails; there is no fallback to the session model. `modelCalls.thinking` is one of pi's thinking levels (`off` … `max`), default `off`, independent of the session's thinking level and ignored by models without reasoning. Each call sends `maxTokens = min(modelCalls.maxOutputTokens, model.maxTokens)`.
  - **Budget.** `modelCalls.maxPerCell` (default 100) Model calls per Cell; the next call fails before it is sent, calls in flight finish. No session budget and no USD cap: cost is 0 or unknown for local, unpriced, and subscription models, and session cost is already in pi's footer.
  - **Usage.** The usage of every Model call in a Cell is summed into the `ipython` tool result's `usage`, so pi counts it in the footer, `/session`, RPC totals, and the session file. Results returned after a Kernel replacement or abort keep the usage gathered so far.
  - **Lifetime.** As for Bridged calls: allowed only while the Cell's `ipython` call runs, aborted with its signal (Esc), and failing at once, before anything is sent, from background tasks after the Cell ended.
  - **Errors.** Every Model-call failure (turned off, no usable model for the call, limit reached, provider error, aborted, called after the Cell ended) raises `pi.ModelCallError` (a `RuntimeError`, no subclasses) with the provider's error text when there is one. Argument validation and local image encoding happen before the host call; invalid arguments raise `TypeError`, and Pillow encoding errors (for example, trying to save a closed image) propagate from Pillow. A `pi.ask` reply cut off at the output limit raises `pi.ModelCallError` instead of returning partial text; any reported usage still counts.
  - **Config.** `modelCalls.enabled` (default `false`), `modelCalls.model`, `modelCalls.classifier` (unset), `modelCalls.maxPerCell` (100), `modelCalls.maxOutputTokens` (4096), `modelCalls.thinking` (`off`). The concurrency of 8 is fixed. Project `modelCalls.*` keys apply only when the project is trusted, with a warning otherwise, since they spend the user's credentials.
  - **Pillow** (#81). The default uv Kernel package set includes `pillow`, labelled `PIL (Pillow)` in the system prompt and not imported by the prelude. The new package set gets its own venv under ADR 0004, warmed at `session_start`. Classify also accepts Pillow images in other Kernel environments when Pillow is available there.
  - **Model-facing docs** (ADR 0007). While `modelCalls.enabled` is on, the live `ipython` description documents each API only if its model resolves with credentials. The shared per-Cell budget, in-flight cap, Cell lifetime, and `pi.ModelCallError` come before the API examples. The guidance names no model and does not appear in the system prompt. Only a `pi.ask` model or classifier whose `input` includes `"image"` advertises `images=` and the supported paths, bytes, or PIL.Image inputs and PNG/JPEG/WebP/GIF formats, in one line naming the APIs it applies to when both take images.
  - **TUI.** The Cell result shows one line, `N model calls · X tok · $Y`, updated live while the Cell runs.
- **No limit on Bridged calls per Cell.** pi's hooks and permission checks guard each call; revisit only if runaway loops show up.
- **Output limits stay at pi's defaults.** The README explains the trade-off of a lower `output.maxBytes` (#74). Revisit the default only with session stats (#57).
- **README defaults are tested** against `config.ts` (#73).
- Measurement (#57, #63) runs in parallel and does not block these.

## Open questions (decide before v2)

- Snapshot semantics across branches, resume, and Kernel crash.
- The wording of the wake-up message, and the guard against wake-up loops.
- Whether to keep Unharnessed's 16 MiB/256 MiB caps.

These are tracked as open questions on #25 and #26.

## Success criteria for v1

- With the extension loaded, the model can load a file into a variable in one Cell and query it in a later Cell without re-reading it, including across a manual `/compact`.
- Aborting a long-running Cell interrupts it. A Kernel that stays wedged can be killed from the UI.
- Quitting pi leaves no orphan Kernel processes behind.
- The integration tests pass against a real Kernel.
