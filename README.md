# pi-ipython

A [pi](https://pi.dev) extension that makes the model work through Python. Modelled on Unharnessed.

With the extension on, the model has **one tool: `ipython`**. Each call sends a piece of Python code (a **Cell**) to a Python process (the **Kernel**) that keeps running for the whole session. Python works much like a Jupyter notebook here:

- Variables, functions, and imports from one Cell are still there in later Cells.
- They are also still there after pi compacts the conversation.
- The model reads files, runs commands, and calls other tools from Python.

```python
# Cell 1
data = json.loads(Path("package.json").read_text())

# Cell 2: `data` is still defined
print(data["version"])
```

## ⚠️ Safety: read this first

**The Kernel is not a sandbox.** Python code runs as your user account. It can read, change, and delete your files, start programs, and use the network.

**pi's tool guards don't see what Python does.** pi's permission checks only see the `ipython` call. They don't see the file writes or shell commands that happen inside the Cell.

The only exception is when a Cell calls another pi tool with `await pi.tool(...)` (a **Bridged call**). That call goes through pi like a normal tool call, so validation, hooks, and permission checks still apply.

- A Bridged call can only run while its Cell is running. Pressing Esc stops the Cell and its Bridged calls. If a background thread calls `pi.tool` after its Cell has finished, it gets a `pi.ToolError` and the tool doesn't run.

**Want to approve each Cell?** Set `"confirmEachCell": true` (see [Configuration](#configuration)).

- pi shows you the code before it runs. If you reject it, the Cell doesn't run and the model is told "rejected by user".
- One approval covers the whole Cell, including any Bridged calls in it.
- Print mode has no UI to ask you, so every Cell is refused there.

**For untrusted work, run pi in a container.** This covers unfamiliar repositories, prompts or data you don't trust, and anything you wouldn't run yourself. See pi's `docs/containerization.md`.

## Quick start

**You need:** pi, and [uv](https://docs.astral.sh/uv/) on your `PATH`. uv downloads Python for you (3.13 by default), so you don't need Python installed.

From npm (once the package is published):

```bash
# Install for all sessions
pi install npm:pi-ipython

# ...or only for this project (writes .pi/settings.json)
pi install -l npm:pi-ipython

# ...or try it for one run without adding it to settings
pi -e npm:pi-ipython
```

To install directly from GitHub instead, run `pi install git:github.com/hiennguyen9874/pi-ipython`.

**To go back to normal pi**, disable the extension in `pi config` (use `pi config --local` for one project). To uninstall it, run `pi remove npm:pi-ipython` (or use the original GitHub source if you installed from GitHub).

## What changes when it's enabled

- **Tools:** `ipython` is the only tool the model can call. Other tools still work, but only from Python (see [below](#using-other-pi-tools-and-mcp)).
- **System prompt:** pi's system prompt is kept, with an `<ipython>` section for the Python REPL and the skills list added (see [System prompt](#system-prompt)).
- **Kernel lifetime:**
  - The Python environment is set up in the background when the session starts.
  - The Kernel starts on the first Cell.
  - It stops when you quit, reload, or switch sessions.
- **Ready-made imports:** every Kernel imports these at startup, so Cells can use them right away:
  - `json`, `os`, `re`, `sys`, `time`, `math`, `shutil`, `itertools`, `functools`, `collections`, `textwrap`
  - `Path`, `datetime`, `timedelta`, `Counter`, `defaultdict`
  - `np` (numpy), `pd` (pandas), `requests`, `httpx`, `yaml` (only with the default [Kernel packages](#kernel-packages))

  These imports exist only in the REPL, so scripts the model writes to disk still need their own imports. To turn them off or add your own, use the `prelude` setting.

## System prompt

pi-ipython adds to pi's system prompt instead of replacing it. At the start of each run it inserts two sections into the prompt pi has built, so a default setup ends up in this order:

```text
You are a coding assistant running inside pi, ...   (pi's opening text)
<tools>            only `ipython`
<rules>            pi's rules and guidelines, with no advice to use bash or read
<ipython>          added by pi-ipython
<docs>             pi's documentation pointers
<project_context>  AGENTS.md files
<skills>           added by pi-ipython, only when you have skills
<cwd>
```

The two added sections:

- `<ipython>`: how to use the REPL. It always covers `bash()` and the rules. Some parts depend on your settings:
  - The ready-made imports are listed unless `prelude.prompt` is `false`.
  - The Kernel packages and the command to install more are listed only with `python.source: "uv"`.
  - The rule about `[bash-done …]` notices appears only when `backgroundNotices` is on (TUI and RPC).

  `<ipython>` goes before `<docs>`. If `<docs>` is missing, it goes before the first of `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`, or at the end. To change this, set `systemPrompt.ipythonAfter` and `systemPrompt.ipythonBefore` (see [Configuration](#configuration)).
  - Another extension that also inserts before `<docs>` ends up before or after `<ipython>` depending on load order (pi loads local extensions before packages). Set `"systemPrompt": { "ipythonAfter": ["rules"] }` to put `<ipython>` ahead of extensions that insert before `<docs>`. A later handler that inserts directly after `</rules>` can still put its text first. Prompts without `<rules>` (`SYSTEM.md` / `--system-prompt`) fall back to `ipythonBefore`.
- `<skills>`: your skills list, with a note telling the model to read `SKILL.md` with Python. pi leaves the list out because no file-reading tool is active. It goes before `<cwd>`. Without skills (or with `--no-skills`) the section is skipped.

A section that is already in the prompt is not added again.

What happens to the rest:

- pi's own sections stay. They don't name the tools pi-ipython hides.
- `SYSTEM.md` / `--system-prompt` replaces pi's opening text, `<tools>`, `<rules>`, and `<docs>`, as usual. `<ipython>` is still added.
- `APPEND_SYSTEM.md` / `--append-system-prompt`, `AGENTS.md` files, and cwd stay.
- Other extensions that edit `event.systemPrompt` in `before_agent_start` keep their changes, whether they run before or after pi-ipython.
- pi-ipython returns the prompt as `systemPrompt`, so it stays fixed for the whole run. Later edits to `systemPromptOptions.sections` or `promptGuidelines` do not change the forced text. A later handler can replace it by returning a prompt without using `event.systemPrompt`, or restore pi's structured prompt by clearing `forceSystemPrompt`.
- The `pi` API for other tools is described in the `ipython` tool description, not the system prompt, so it can change during a run. It is shown only while the Kernel can call at least one other tool, and adds about 1–1.5 KB to the description. pi does not shorten tool descriptions, and provider limits on description length have not been checked.
- The prompt has no date (pi's default has none either). If the model needs one, add it with `APPEND_SYSTEM.md` or an extension.

## Kernel packages

The uv environment comes with these packages installed: requests, httpx, pyyaml, tomli, python-dotenv, pandas, numpy, scipy, beautifulsoup4, lxml, pydantic, tyro. The system prompt lists them.

- **Add your own** with `python.packages` (uv requirement strings, e.g. `"polars"` or `"rich>=13"`). Global and trusted project lists are combined; pi ignores package entries from untrusted projects. Use absolute paths for local packages.
- **Turn the defaults off** with `python.defaultPackages: false`.
- **During a session** the model can install more with `import shlex, sys; await bash(f"uv pip install --python {shlex.quote(sys.executable)} package-name")` (replace `package-name`). Those installs aren't recorded: they're lost when the environment is rebuilt (for example after a pi-ipython upgrade). To keep a package, add it to `python.packages`.
- **Each package list gets its own environment**, in `~/.pi/agent/pi-ipython/kernel-venv-<version>-<hash>` (full package-set hash; no hash for an empty set), so projects with different lists don't rebuild each other's. If set, `PI_IPYTHON_VENV_DIR` replaces the path prefix, not the version or hash. Old directories, including those from the shorter-hash layout, aren't cleaned up yet.
- If a package fails to install, the Kernel doesn't start and the error names `python.packages`.
- With `python.source: "project"` nothing is installed: Kernel packages are ignored, with a warning if `python.packages` is set.

To pre-import all default packages, not just the common ones:

```json
{
  "prelude": {
    "imports": [
      "import scipy, tomli, dotenv, lxml, pydantic, tyro",
      "from bs4 import BeautifulSoup",
      "from pydantic import BaseModel"
    ]
  }
}
```

### Troubleshooting: `No module named 'hatchling'`

With `python.source: "uv"`, the Kernel uses its own virtual environment, not the host project's `.venv`. But uv can still pick up settings from the enclosing project, especially when pi-ipython is installed locally under `.pi/git/`.

If the runtime build fails with `ModuleNotFoundError: No module named 'hatchling'`, check the host project's `[tool.uv]` settings in `pyproject.toml` (or its `uv.toml`). A global `no-build-isolation = true` prevents uv from creating a separate build environment and installing the runtime's declared build dependency, `hatchling`. If only a specific package needs this behavior, remove the global setting and keep a package-specific exception, for example `no-build-isolation-package = ["flash-attn"]`.

To test without uv's configuration files or the environment variable that disables build isolation, restart pi with:

```bash
env -u UV_NO_BUILD_ISOLATION UV_NO_CONFIG=1 pi
```

This also skips uv settings such as custom indexes and mirrors, so prefer fixing the specific setting. If the Kernel reuses an existing environment, it won't rebuild the runtime and this command won't test the build.

## Using other pi tools and MCP

Tools from other extensions you load (including MCP servers) don't show up as separate tools for the model. The model calls them from Python with the `pi` object:

```python
await pi.tools()                            # list callable tools
await pi.search("screenshot", limit=8)      # find tools by keyword
await pi.search("fetch", namespace="docs")  # search inside one namespace
await pi.describe("tool_name")              # parameters and docs for one tool
await pi.describe_namespace("mcp__docs")    # e.g. an MCP server's instructions
await pi.tool("tool_name", {"arg": "value"})  # call a tool
```

**Results and errors**

- `pi.tool` returns a **dict** if the tool declares an output schema (all MCP tools do). Otherwise it returns **text**.
- A failed call raises `pi.ToolError`.
  - `e.result` holds the structured error result if the tool has an output schema, for example an MCP tool's whole `CallToolResult`.
  - Otherwise `e.result` is `None`. This also applies to blocked calls, bad arguments, and unknown tools.

**Which tools the model can see and call**

- The `ipython` tool description lists tools with `direct` or `codemode` exposure. The list is capped at about 3000 tokens; a namespace that doesn't fit is marked `(some tools not listed)` or `(tools not listed)`.
- `deferred` tools aren't listed, but the model can still find them with `pi.tools()` and `pi.search()` and call them. MCP registers its `codemode` and `deferred` servers' tools as `deferred`, so only `direct` MCP tools appear in the description.
- `hidden` tools can't be called at all.
- To remove the list from the description, set `piTools.list: false`.

**How `pi.search` works**

- It ranks every callable tool with BM25 over names, descriptions, parameters, and namespaces.
- A query that exactly matches a tool's name puts that tool first.
- With `namespace=`, only that namespace is searched. A namespace with no callable tools raises `pi.ToolError`.
- To turn search off, set `piTools.search: false`. Calls then raise `pi.ToolError` and the `ipython` description no longer mentions it.

### MCP

Load pi's built-in MCP extension next to this one. If you use `--no-extensions`, load it explicitly:

```bash
pi --no-extensions --no-skills -e src/index.ts -e builtin:mcp \
  -p 'Use ipython to run print(await pi.tools())'
```

MCP resources are read through pi's resource tools, which return dicts:

```python
listing = await pi.tool("list_mcp_resources", {})
# {"resources": [{"server", "uri", "name", ...}]}

page = await pi.tool("read_mcp_resource",
                     {"server": "docs", "uri": listing["resources"][0]["uri"]})
page["contents"]   # [{"uri", "mimeType", "text" or "blob"}]
```

There is also `list_mcp_resource_templates`. These tools only exist while a non-`hidden` server offers resources. By default they aren't listed in the description, but `pi.tools()` and `pi.search()` find them.

**Good to know**

- Cells wait until MCP tools have registered before they run.
- You don't need `builtin:codemode` or `builtin:tool-search`.
- Connection problems: run `pi mcp list`. Servers that need login: run `pi mcp login <server>`.
- A project's `.pi/mcp.json` is only read in trusted projects.

## Configuration

There are two config files:

- **Global:** `~/.pi/agent/pi-ipython.json`
- **Project:** `.pi/pi-ipython.json`

Project values override global ones key by key. The exceptions are `prelude.imports` and `python.packages`: global and project lists are combined (trusted projects only for `python.packages`). Bad values and unknown keys are reported with the file and key. An invalid entry is skipped, except when an invalid `systemPrompt` value wins the merge: then both placement settings use their defaults.

Defaults:

```json
{
  "confirmEachCell": false,
  "backgroundNotices": false,
  "python": { "source": "uv", "version": "3.13", "defaultPackages": true, "packages": [] },
  "output": { "maxBytes": 51200, "maxLines": 2000 },
  "piTools": { "list": true, "search": true },
  "prelude": { "defaults": true, "imports": [], "prompt": true },
  "systemPrompt": {
    "ipythonAfter": [],
    "ipythonBefore": ["docs", "addendum", "project_context", "skills", "cwd"]
  }
}
```

| Key | Default | What it does |
|---|---|---|
| `confirmEachCell` | `false` | Ask you to approve each Cell before it runs. |
| `backgroundNotices` | `false` | When a `bash()` command that outlived its Cell finishes, send the model a `[bash-done pid:… exit:…]` notice. If the session is idle, the notice starts a new turn. Notices that arrive close together go out as one. After 5 consecutive turns started by notices (or when you abort one), notices wait for your next message. TUI and RPC only. |
| `python.source` | `"uv"` | `"uv"`: use a separate environment managed by uv. `"project"`: use your project's `<cwd>/.venv`, so Cells can import your project's packages (uv not required). |
| `python.version` | `"3.13"` | Python version for the uv environment (3.11 or newer). |
| `python.defaultPackages` | `true` | Install the default [Kernel packages](#kernel-packages) and pre-import `np`, `pd`, `requests`, `httpx`, `yaml` (uv only). |
| `python.packages` | `[]` | Kernel packages for the uv environment, as uv requirement strings. Entries that are empty or start with `-` are skipped with a warning. |
| `output.maxBytes` / `output.maxLines` | `51200` / `2000` | When a Cell prints more than this, only the end is shown. The full output is saved to a Spill file, and the result includes its path. |
| `prelude.defaults` | `true` | Load the [ready-made imports](#what-changes-when-its-enabled). |
| `prelude.imports` | `[]` | Extra imports for every Kernel, e.g. `"import numpy as np"`. See the rules below. |
| `prelude.prompt` | `true` | List the prelude in the system prompt. With `false` the imports still run, just without telling the model. |
| `piTools.list` | `true` | List callable `direct`/`codemode` tools in the `ipython` description. |
| `piTools.search` | `true` | Enable `pi.search()`. |
| `systemPrompt.ipythonAfter` | `[]` | Section tag names. `<ipython>` goes right after the first one present in the prompt. Checked before `ipythonBefore`. See [System prompt](#system-prompt). |
| `systemPrompt.ipythonBefore` | `["docs", "addendum", "project_context", "skills", "cwd"]` | Section tag names. If no `ipythonAfter` section is present, `<ipython>` goes before the first one present, or at the end if none is. |

Rules for `prelude.imports`:

- Each entry must be a single absolute `import …` or `from … import …` statement, without `*`. Anything else is skipped with a warning.
- If an import fails when the Kernel starts (for example, the package isn't installed), you get a warning and the other imports still run.

## Packaging and publishing

Pi loads `src/index.ts` directly, so no JavaScript build or bundling step is needed. The npm tarball includes the Python runtime sources and uv lockfile; uv sets up the Kernel environment separately.

```bash
npm pack --dry-run  # inspect the file list
npm pack            # create pi-ipython-<version>.tgz
```

To try the exact packaged contents before publishing, extract the tarball to a temporary directory and point Pi at its `package/` directory:

```bash
scratch=$(mktemp -d)
tar -xzf pi-ipython-0.1.0.tgz -C "$scratch"  # use the filename printed by npm pack
pi -e "$scratch/package"
```

### Automated npm releases

[The GitHub Actions workflow](.github/workflows/npm.yml) runs type checks and the TypeScript and Python tests, then uploads the npm tarball. Pull requests and pushes to `master` build only. Pushing a tag such as `v0.1.1` publishes that same tarball after the checks pass, provided the tag matches the version in `package.json`.

**One-time setup:** If `pi-ipython` does not exist on npm yet, an npm owner must publish the first version manually (`npm publish --access public`) so the package settings are available. Then add a [trusted publisher](https://docs.npmjs.com/trusted-publishers/) in the package's npm settings: select **GitHub Actions**, set owner to `hiennguyen9874`, repository to `pi-ipython`, workflow filename to `npm.yml`, and environment to `npm`. Under **Allowed actions**, enable `npm publish` (allowing only `npm stage publish` is not enough). Create the matching `npm` environment in GitHub. The workflow uses OIDC and does not need an `NPM_TOKEN` secret.

**For each automated release:** bump `package.json` and `package-lock.json` together (for example, with `npm version patch --no-git-tag-version`), merge the change, then tag that commit and push the tag. Use a version that hasn't already been published.

```bash
git tag v0.1.1  # example: must match package.json on this commit
git push origin v0.1.1
```

## License

MIT. Includes code from Unharnessed, Prime Intellect, and Mario Zechner. See `LICENSE` and `NOTICE`.
