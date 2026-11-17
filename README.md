# pi-ipython

A [pi](https://pi.dev) extension that turns a session into a Python-REPL-first agent, modelled on Unharnessed. The model sees one tool, `ipython`. Each call runs one **Cell** in a persistent Python **Kernel** owned by the session. Variables, functions, and imports from earlier Cells stay available in later ones and survive compaction.

## Safety: read this first

- **The Kernel runs with your permissions.** Cell code can read, write, and delete anything your user account can, start processes, and use the network.
- **It is not a sandbox.** There is no isolation or permission gating of Cell code.
- **It bypasses pi's tool-call guards.** Pi's per-tool checks and permission extensions see only the `ipython` call, not the file reads, writes, or shell commands that the Python code does inside it.
- **Bridged calls are guarded; Python is not.** When a Cell calls a Pi tool with `await pi.tool(name, args)`, the call goes through pi like a model-issued one: argument validation, `tool_call`/`tool_result` hooks, and permission checks all apply, so a hook can block it. That covers only Pi tools reached through `pi`. Everything else the Cell's Python does directly is still unguarded and not sandboxed. There is no separate confirmation per Bridged call; `confirmEachCell` approves the whole Cell, including every Bridged call it makes.
- **Bridged calls only run while their Cell runs.** Aborting the Cell (Esc) also aborts its in-flight Bridged calls. A background task or thread that calls `pi.tool` after its Cell returned gets `pi.ToolError` straight away, and the tool does not run.
- **Run it in a container for untrusted work**: unfamiliar repositories, untrusted prompts or data, or anything you would not run yourself. Pi's own docs cover this in `docs/containerization.md`.

To review each Cell before it runs, turn on `confirmEachCell` (see [Configuration](#configuration)). Pi then shows you each Cell's code and asks for approval. A rejected Cell does not run, and the model gets a "rejected by user" result. Without a UI (print mode), confirmation cannot be asked for, so every Cell is refused and the model is told why.

## Install and enable

Requirements: pi, and [uv](https://docs.astral.sh/uv/) on your `PATH` (not needed with `python.source: "project"`). uv fetches the Kernel's Python (3.13 by default), so you don't need a system Python.

Install the package for all your sessions:

```bash
pi install git:github.com/hiennguyen9874/pi-ipython
```

Add `--local` (`-l`) to enable it only for the current project (written to `.pi/settings.json`), or try it for one run without installing:

```bash
pi -e git:github.com/hiennguyen9874/pi-ipython
```

Loading the extension means ipython mode: `ipython` becomes the only active tool and pi's system prompt is replaced with a REPL prompt. Your context files (`AGENTS.md`) and skills stay in it. To go back to normal pi, disable the extension with `pi config` (or `pi config --local` for one project), or remove it with `pi remove git:github.com/hiennguyen9874/pi-ipython`.

The Kernel venv is prepared in the background when a session starts. The Kernel itself starts on the first Cell and is killed when you quit, reload, or switch sessions.

## MCP and other Pi tools

Load other extensions alongside pi-ipython. Their tools are available through Python, not as separate model-facing tools:

```python
await pi.tools()                         # names, descriptions, namespaces
await pi.search("screenshot", limit=8)   # best-matching tools first, same entries as pi.tools()
await pi.describe("tool_name")           # full description, parameter schema, guidelines, returns
await pi.describe_namespace("mcp__docs") # namespace description and instructions (e.g. an MCP server's)
await pi.tool("tool_name", {"arg": "value"})
```

For MCP, load pi's built-in MCP extension (explicitly if using `--no-extensions`):

```bash
pi --no-extensions --no-skills -e src/index.ts -e builtin:mcp \
  -p 'Use ipython to run print(await pi.tools())'
```

The `ipython` description lists the callable Pi tools registered with `direct` or `codemode` exposure (name and first description line, grouped by namespace, up to about 3000 tokens; a namespace that does not fit is marked `(some tools not listed)` or `(tools not listed)`). `deferred` tools are never listed, and MCP registers its `codemode` and `deferred` servers' tools as `deferred`, so only MCP tools with `direct` exposure are listed and connecting servers do not change the description otherwise. Turn the list off with `piTools.list: false`.

`pi.tool` returns a dict for tools with an output schema (every MCP tool has one), otherwise text. A failed call raises `pi.ToolError` with the tool's error text; `e.result` holds the error result's structured content when the tool has an output schema, for example an MCP tool's whole `CallToolResult`, and is `None` otherwise (also for blocked calls, invalid arguments, and unknown tools).

`pi.search(query, limit=8)` ranks every callable Pi tool, listed or not (including `deferred` MCP tools), with BM25 over names, descriptions, parameter schemas, and namespaces; a query that is exactly a tool's name ranks it first. Turn it off with `piTools.search: false`: calls then raise `pi.ToolError` and the system prompt does not mention it.

MCP tools with `direct`, `codemode`, or `deferred` exposure are callable through `pi`; `hidden` tools stay unavailable. MCP resources are reachable the same way, through pi's `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` tools, which return dicts:

```python
listing = await pi.tool("list_mcp_resources", {})  # {"resources": [{"server", "uri", "name", ...}]}
page = await pi.tool("read_mcp_resource", {"server": "docs", "uri": listing["resources"][0]["uri"]})
page["contents"]                                    # [{"uri", "mimeType", "text" or "blob"}]
```

They exist only while a non-`hidden` server offers resources, never reach `hidden` servers, and take the widest exposure of those servers (so by default they are not listed in the description, but `pi.tools()` and `pi.search` find them).

Cells wait for MCP registration before running. Neither `builtin:codemode` nor `builtin:tool-search` is needed for Python discovery. Run `pi mcp list` to diagnose connection failures, and `pi mcp login <server>` for servers that need authentication. Project `.pi/mcp.json` is read only in trusted projects.

## Configuration

Global config lives in `~/.pi/agent/pi-ipython.json`. Project config lives in `.pi/pi-ipython.json` and wins per key. Invalid files, values, and unknown keys are reported and skipped, so the remaining values and defaults apply.

```json
{
  "confirmEachCell": false,
  "python": { "source": "uv", "version": "3.13" },
  "output": { "maxBytes": 51200, "maxLines": 2000 },
  "piTools": { "list": true, "search": true }
}
```

| Key | Default | Meaning |
|---|---|---|
| `confirmEachCell` | `false` | Ask the user to approve each Cell before it runs. |
| `python.source` | `"uv"` | `"uv"`: a managed venv. `"project"`: the project's own `<cwd>/.venv`, so Cells can import your project's packages. |
| `python.version` | `"3.13"` | Python version for the managed venv (3.11 or newer). |
| `output.maxBytes` / `output.maxLines` | 50KB / 2000 | Cell output beyond these limits is truncated to its tail. The full output is saved to a temp file whose path is in the result. |
| `piTools.list` | `true` | List callable `direct`/`codemode` Pi tools in the `ipython` description (see [MCP and other Pi tools](#mcp-and-other-pi-tools)). `false` leaves the description without the list. |
| `piTools.search` | `true` | Enable `pi.search(query, limit=8)` over callable Pi tools. `false` makes it raise `pi.ToolError` and leaves it out of the system prompt. |

## License

MIT. Includes code from Unharnessed, Prime Intellect, and Mario Zechner. See `LICENSE` and `NOTICE`.
