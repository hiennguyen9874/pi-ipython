# pi-ipython

A [pi](https://pi.dev) extension that makes the model work through Python. It is modelled on Unharnessed.

With the extension on, the model has one tool: `ipython`. Each call sends a piece of Python code, called a **Cell**, to a Python process, called the **Kernel**. The Kernel keeps running for the whole session, so it works much like a Jupyter notebook:

- Variables, functions, and imports from one Cell are still defined in later Cells.
- They stay defined after pi compacts the conversation.
- The model reads files, runs commands, and calls other tools from Python.

```python
# Cell 1
data = json.loads(Path("package.json").read_text())

# Cell 2: `data` is still defined
print(data["version"])
```

## Safety: the Kernel is not a sandbox

Read this section before you install the extension.

Python code in a Cell runs as your user account. It can read, change, and delete your files. It can also start programs and use the network.

pi's permission checks see the `ipython` call. They don't see the file writes or shell commands inside the Cell.

The exception is a **Bridged call**: a Cell that calls another pi tool with `await pi.tool(...)`. pi handles a Bridged call like a normal tool call, so validation, hooks, and permission checks still apply. A Bridged call runs only while its Cell runs:

- Press Esc to stop the Cell and its Bridged calls.
- A background thread that calls `pi.tool` after its Cell finishes gets a `pi.ToolError`, and the tool doesn't run.

To approve each Cell before it runs, set `"confirmEachCell": true` in [Configuration](#configuration). With that setting:

- pi shows you the code before it runs. If you reject it, the Cell doesn't run and the model sees "rejected by user".
- One approval covers the whole Cell, including its Bridged calls.
- Print mode has no UI to ask you, so pi refuses every Cell there.

For untrusted work, run pi in a container. Untrusted work includes unfamiliar repositories, prompts or data you don't trust, and code you wouldn't run yourself. See `docs/containerization.md` in pi.

## Quick start

You need pi and [uv](https://docs.astral.sh/uv/) on your `PATH`. uv downloads Python for you (3.13 by default), so you don't need Python installed.

Install from npm with one of these commands:

```bash
# Install for all sessions
pi install npm:pi-ipython

# Install for this project only (writes .pi/settings.json)
pi install -l npm:pi-ipython

# Try it for one run without changing settings
pi -e npm:pi-ipython
```

To install from GitHub instead, run `pi install git:github.com/hiennguyen9874/pi-ipython`.

To go back to normal pi, disable the extension in `pi config`. For one project, use `pi config --local`. To uninstall, run `pi remove npm:pi-ipython`. If you installed from GitHub, pass the GitHub source to `pi remove` instead.

## What changes when the extension is on

- **Tools.** `ipython` is the only tool the model can call. Other tools still work, but only from Python. See [Call other pi tools from Python](#call-other-pi-tools-from-python).
- **System prompt.** pi keeps its system prompt. pi-ipython adds an `<ipython>` section and the skills list. See [System prompt](#system-prompt).
- **Kernel lifetime.** pi-ipython sets up the Python environment in the background when the session starts. The Kernel starts on the first Cell. It stops when you quit, reload, or switch sessions.
- **Ready-made imports.** Every Kernel runs these imports at startup, so Cells can use the names right away:
  - `json`, `os`, `re`, `sys`, `time`, `math`, `shutil`, `itertools`, `functools`, `collections`, and `textwrap`
  - `Path`, `datetime`, `timedelta`, `Counter`, and `defaultdict`
  - `np` (numpy), `pd` (pandas), `requests`, `httpx`, and `yaml`, with the default [Kernel packages](#kernel-packages) only

  These imports exist only in the REPL. Scripts that the model writes to disk still need their own imports. To turn the imports off or add your own, use the `prelude` settings.

## System prompt

pi-ipython adds to pi's system prompt instead of replacing it. At the start of each run, it inserts two sections into the prompt that pi built. A default setup ends up in this order:

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

### The `<ipython>` section

`<ipython>` tells the model how to use the REPL. It always covers `bash()` and the rules for working in Cells. Other parts depend on your settings:

| Part | Included when |
|---|---|
| Rules for parallel work and waiting, and the concurrent Bridged calls hint in the tool description | `parallelWorkPrompt` is not `false` |
| The ready-made imports | `prelude.prompt` is not `false` |
| The Kernel packages, minus the pre-imported ones, and the command to install more | `python.source` is `"uv"` |
| The rule about `[bash-done …]` notices | TUI and RPC modes, and `backgroundNotices` is not `false` |

pi-ipython places `<ipython>` before `<docs>`. If the prompt has no `<docs>`, `<ipython>` goes before the first section present among `<addendum>`, `<project_context>`, `<skills>`, and `<cwd>`. If none of them is present, it goes at the end. To change the placement, set `systemPrompt.ipythonAfter` and `systemPrompt.ipythonBefore`.

Another extension can also insert text before `<docs>`. Load order then decides whether that text lands before or after `<ipython>`. pi loads local extensions before packages. To put `<ipython>` ahead of those extensions, set `"systemPrompt": { "ipythonAfter": ["rules"] }`. A later handler that inserts directly after `</rules>` can still put its text first. A prompt from `SYSTEM.md` or `--system-prompt` has no `<rules>`, so placement falls back to `ipythonBefore`.

### The `<skills>` section

`<skills>` lists your skills and tells the model to read each `SKILL.md` with Python. pi leaves the list out on its own because no file-reading tool is active. The section goes before `<cwd>`. pi-ipython skips it when you have no skills or pass `--no-skills`.

### The rest of the prompt

pi-ipython doesn't add a section that is already in the prompt. The rest of the prompt behaves as follows:

- pi's own sections stay. They don't name the tools that pi-ipython hides.
- `SYSTEM.md` and `--system-prompt` replace pi's opening text, `<tools>`, `<rules>`, and `<docs>`, as usual. pi-ipython still adds `<ipython>`.
- `APPEND_SYSTEM.md`, `--append-system-prompt`, `AGENTS.md` files, and the cwd stay.
- Other extensions that edit `event.systemPrompt` in `before_agent_start` keep their changes, whether they run before or after pi-ipython.
- pi-ipython returns the prompt as `systemPrompt`, so the prompt stays fixed for the whole run. Later edits to `systemPromptOptions.sections` or `promptGuidelines` don't change the forced text. A later handler can replace the prompt by returning one that doesn't use `event.systemPrompt`. It can also restore pi's structured prompt by clearing `forceSystemPrompt`.
- The `ipython` tool description, not the system prompt, documents the `pi` API for other tools. The description can change during a run. It includes the API only while the Kernel can call at least one other tool, which adds about 1 to 1.5 KB. pi doesn't shorten tool descriptions. Provider limits on description length are untested.
- The prompt has no date, and pi's default prompt has none either. If the model needs the date, add it with `APPEND_SYSTEM.md` or an extension.

## Kernel packages

The uv environment comes with these packages: requests, httpx, pyyaml, tomli, python-dotenv, pandas, numpy, scipy, beautifulsoup4, lxml, pydantic, tyro, and pillow. The system prompt lists pillow as `PIL (Pillow)`. Pillow is not pre-imported, so use `from PIL import Image`.

- **Add packages** with `python.packages`, as uv requirement strings such as `"polars"` or `"rich>=13"`. pi-ipython combines the global and project lists. It ignores package entries from untrusted projects. Use absolute paths for local packages.
- **Turn off the defaults** with `python.defaultPackages: false`.
- **Install during a session.** The model can run `import shlex, sys; await bash(f"uv pip install --python {shlex.quote(sys.executable)} package-name")`, with `package-name` replaced. pi-ipython doesn't record these installs. They are lost when the environment is rebuilt, for example after a pi-ipython upgrade. To keep a package, add it to `python.packages`.
- **Each package list gets its own environment** in `~/.pi/agent/pi-ipython/kernel-venv-<version>-<hash>`. The hash covers the full package set, and an empty set has no hash. Projects with different lists don't rebuild each other's environments. `PI_IPYTHON_VENV_DIR` replaces the path prefix but not the version or the hash. pi-ipython doesn't clean up old directories yet, including directories from the older, shorter-hash layout.
- **A failed install** stops the Kernel from starting. The error names `python.packages`.
- **With `python.source: "project"`**, pi-ipython installs nothing and ignores Kernel packages. It warns you if `python.packages` is set.

To pre-import every default package, not just the common ones, add this to your config:

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

With `python.source: "uv"`, the Kernel uses its own virtual environment, not the `.venv` of your project. uv can still pick up settings from the enclosing project. This happens most often when pi-ipython is installed locally under `.pi/git/`.

If the runtime build fails with `ModuleNotFoundError: No module named 'hatchling'`, check the `[tool.uv]` settings in your project's `pyproject.toml` or `uv.toml`. A global `no-build-isolation = true` stops uv from creating a separate build environment. uv then can't install `hatchling`, which the runtime declares as its build dependency. If one package needs that behavior, remove the global setting and add a package-specific exception, such as `no-build-isolation-package = ["flash-attn"]`.

To test without uv's config files and without the variable that disables build isolation, restart pi with this command:

```bash
env -u UV_NO_BUILD_ISOLATION UV_NO_CONFIG=1 pi
```

The command also skips uv settings such as custom indexes and mirrors, so fixing the specific setting is the better long-term fix. If the Kernel reuses an existing environment, it doesn't rebuild the runtime, and the command doesn't test the build.

## Call other pi tools from Python

Tools from other extensions, including MCP servers, don't appear to the model as separate tools. The model calls them from Python through the `pi` object:

```python
await pi.tools()                              # list callable tools
await pi.search("screenshot", limit=8)        # find tools by keyword
await pi.search("fetch", namespace="docs")    # search inside one namespace
await pi.describe("tool_name")                # parameters and docs for one tool
await pi.describe_namespace("mcp__docs")      # namespace docs, such as an MCP server's instructions
await pi.tool("tool_name", {"arg": "value"})  # call a tool
```

### Results and errors

- `pi.tool` returns a dict if the tool declares an output schema. All MCP tools declare one. Other tools return text.
- A failed call raises `pi.ToolError`. If the tool has an output schema, `e.result` holds the structured error result, such as the whole `CallToolResult` of an MCP tool. Otherwise `e.result` is `None`. Blocked calls, bad arguments, and unknown tools also leave `e.result` as `None`.

### Tool visibility

Each tool has an exposure level that controls whether the model sees it:

| Exposure | Listed in the `ipython` description | Found by `pi.tools()` and `pi.search()` | Callable |
|---|---|---|---|
| `direct`, `codemode` | Yes | Yes | Yes |
| `deferred` | No | Yes | Yes |
| `hidden` | No | No | No |

- The list in the description is capped at about 3000 tokens. A namespace that doesn't fit is marked `(some tools not listed)` or `(tools not listed)`.
- MCP registers the tools of its `codemode` and `deferred` servers as `deferred`. Only `direct` MCP tools appear in the description.
- To remove the list from the description, set `piTools.list: false`.

### How `pi.search` ranks tools

- `pi.search` ranks every callable tool with BM25 over names, descriptions, parameters, and namespaces.
- A query that exactly matches a tool name puts that tool first.
- With `namespace=`, it searches only that namespace. A namespace with no callable tools raises `pi.ToolError`.
- To turn search off, set `piTools.search: false`. Calls to `pi.search` then raise `pi.ToolError`, and the `ipython` description stops mentioning search.

### MCP

Load pi's built-in MCP extension next to pi-ipython. If you use `--no-extensions`, load both explicitly:

```bash
pi --no-extensions --no-skills -e src/index.ts -e builtin:mcp \
	-p 'Use ipython to run print(await pi.tools())'
```

Read MCP resources through pi's resource tools, which return dicts:

```python
listing = await pi.tool("list_mcp_resources", {})
# {"resources": [{"server", "uri", "name", ...}]}

page = await pi.tool("read_mcp_resource",
                     {"server": "docs", "uri": listing["resources"][0]["uri"]})
page["contents"]   # [{"uri", "mimeType", "text" or "blob"}]
```

A third tool, `list_mcp_resource_templates`, lists resource templates. The resource tools exist only while a server that isn't `hidden` offers resources. The description doesn't list them by default, but `pi.tools()` and `pi.search()` find them.

Keep these points in mind:

- Cells wait for MCP tools to register before they run.
- You don't need `builtin:codemode` or `builtin:tool-search`.
- For connection problems, run `pi mcp list`. For servers that need a login, run `pi mcp login <server>`.
- pi reads a project's `.pi/mcp.json` in trusted projects only.

## Model calls

A **Model call** is a request from a Cell to a model outside the conversation. Model calls are off by default. To turn them on, set `modelCalls.enabled: true`. Model calls spend your credentials and money, and pi adds their usage to the session totals.

- `await pi.ask(prompt, system=None, images=None)` returns a text answer from the chat model.
- `await pi.classify(state, questions)` sends JSON state to the classifier and returns bool, choice, or score answers by question ID.

Both functions share one budget: `modelCalls.maxPerCell` calls per Cell, with at most 8 in flight at once. One `pi.classify` request counts as one Model call, even when it answers several questions.

### Images

`pi.ask` and `pi.classify` both accept an optional `images=[...]` list. The list can mix these types:

- Paths, as `str` or `os.PathLike`. Relative paths resolve against the Kernel's current directory.
- Bytes-like values: `bytes`, `bytearray`, or `memoryview`.
- Pillow images (`PIL.Image.Image`). The Kernel encodes them as PNG without resizing and converts them to RGB or RGBA when needed.

The host detects PNG, JPEG, WebP, and GIF from the file content. It doesn't resize images and applies no size limit or path restrictions. Provider limits still apply.

- **`pi.ask`** sends the images before the prompt text in one user message. The images go to the same model as the text. That model must support images, or the call raises `pi.ModelCallError` before it spends budget. `images=[]` works with any model. One call counts as one Model call, however many images it carries. A call that the provider rejects still counts. The `ipython` description mentions `images` only while the `pi.ask` model supports them.
- **`pi.classify`** needs a classifier that supports images.

Invalid image arguments raise `TypeError`. These cases raise `pi.ModelCallError` before the call spends budget: an unreadable file, an unsupported format, or images sent to a text-only model.

### Known provider issues

- OpenRouter accepts images in TypeSafe's format but drops them without an error.
- GPT-6 Luna needs an API key. ChatGPT `/login` doesn't work.

## Configuration

pi-ipython reads two config files:

- Global: `~/.pi/agent/pi-ipython.json`
- Project: `.pi/pi-ipython.json`

Project values override global values key by key, with these exceptions:

- pi-ipython combines the global and project lists for `prelude.imports` and `python.packages`. It uses project `python.packages` from trusted projects only.
- pi-ipython applies project `modelCalls.*` keys only when pi trusts the project. Otherwise it ignores them and warns you.

pi-ipython reports bad values and unknown keys with the file and the key, and skips the invalid entry. If an invalid `systemPrompt` value wins the merge, both placement settings fall back to their defaults.

These are the defaults:

```json
{
	"confirmEachCell": false,
	"backgroundNotices": true,
	"parallelWorkPrompt": true,
	"python": { "source": "uv", "version": "3.13", "defaultPackages": true, "packages": [] },
	"output": { "maxBytes": 51200, "maxLines": 2000 },
	"commandLog": { "maxBytes": 33554432 },
	"piTools": { "list": true, "search": true },
	"prelude": { "defaults": true, "imports": [], "prompt": true },
	"systemPrompt": {
		"ipythonAfter": [],
		"ipythonBefore": ["docs", "addendum", "project_context", "skills", "cwd"]
	},
	"modelCalls": { "enabled": false, "maxPerCell": 100, "maxOutputTokens": 4096, "thinking": "off" }
}
```

| Key | Default | Effect |
|---|---|---|
| `confirmEachCell` | `false` | Asks you to approve each Cell before it runs. |
| `backgroundNotices` | `true` | Sends the model a notice when a Background command finishes. See [Background-command notices](#background-command-notices). TUI and RPC modes only. |
| `parallelWorkPrompt` | `true` | Includes guidance for parallel commands, waiting, and concurrent Bridged calls. `backgroundNotices` controls Background-command notices separately. |
| `python.source` | `"uv"` | `"uv"` uses a separate environment that uv manages. `"project"` uses `<cwd>/.venv`, so Cells can import your project's packages. `"project"` doesn't need uv. |
| `python.version` | `"3.13"` | Python version for the uv environment. Must be 3.11 or newer. |
| `python.defaultPackages` | `true` | Installs the default [Kernel packages](#kernel-packages) and pre-imports `np`, `pd`, `requests`, `httpx`, and `yaml`. uv only. |
| `python.packages` | `[]` | Kernel packages for the uv environment, as uv requirement strings. pi-ipython skips empty entries and entries that start with `-`, and warns you. |
| `output.maxBytes` | `51200` | Byte limit for a Cell result. See [Output limits](#output-limits). |
| `output.maxLines` | `2000` | Line limit for a Cell result. |
| `commandLog.maxBytes` | `33554432` (32 MiB) | Size cap for each Command log file. See [Output limits](#output-limits). |
| `prelude.defaults` | `true` | Loads the [ready-made imports](#what-changes-when-the-extension-is-on). |
| `prelude.imports` | `[]` | Extra imports for every Kernel, such as `"import numpy as np"`. See [Prelude imports](#prelude-imports). |
| `prelude.prompt` | `true` | Lists the prelude in the system prompt. With `false`, the imports still run, but the model isn't told about them. |
| `piTools.list` | `true` | Lists callable `direct` and `codemode` tools in the `ipython` description. |
| `piTools.search` | `true` | Turns on `pi.search()`. |
| `systemPrompt.ipythonAfter` | `[]` | Section tag names. `<ipython>` goes right after the first one present in the prompt. pi-ipython checks this list before `ipythonBefore`. |
| `systemPrompt.ipythonBefore` | `["docs", "addendum", "project_context", "skills", "cwd"]` | Section tag names. If no `ipythonAfter` section is present, `<ipython>` goes before the first one present, or at the end if none is present. |
| `modelCalls.enabled` | `false` | Turns on `pi.ask` and `pi.classify`. Trusted projects only. |
| `modelCalls.model` | unset | Chat model for `pi.ask`, as an exact `provider/id`. Unset means the current session model. If the model isn't found or has no credentials, you get a warning at startup and `pi.ask` fails. There is no fallback. Trusted projects only. |
| `modelCalls.classifier` | unset | Classifier for `pi.classify`, as an exact `provider/id`. There is no default. If the classifier isn't found or has no credentials, you get a warning at startup when Model calls are on, and `pi.classify` fails. Trusted projects only. |
| `modelCalls.maxPerCell` | `100` | Model calls allowed per Cell. The next call fails before pi-ipython sends it. Trusted projects only. |
| `modelCalls.maxOutputTokens` | `4096` | Output-token cap for `pi.ask`. The model's own limit also applies. Trusted projects only. |
| `modelCalls.thinking` | `"off"` | Thinking level for `pi.ask`: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`. Models without reasoning ignore it. Trusted projects only. |

### Background-command notices

A **Background command** is a `bash()` command that is still running after its Cell ends. When one finishes, pi-ipython sends the model a `[bash-done pid:… exit:…]` notice:

- If the session is idle, the notice starts a new turn.
- Notices that arrive close together go out as one notice.
- After 5 turns in a row that notices started, or after you abort one of those turns, notices wait for your next message.

### Output limits

When a Cell prints more than `output.maxBytes` or `output.maxLines`, the result keeps the start (about 20%) and the end (about 80%). A `[… N lines elided, full output in <path>]` marker replaces the middle. The full output goes to that **Spill file**.

A smaller limit means the model re-reads less result text on later turns, but it may need extra Cells to read the Spill file. For long sessions or expensive models, try `output.maxBytes` around `16384`.

A `bash()` command that prints more than 2 MiB keeps its first 512 KiB and its last 1.5 MiB in memory. Its full output goes to a **Command log** under the session's state directory. pi-ipython deletes the state directory when the session ends. The dropped-middle marker in `.output()` and `.tail()` names the Command log, and so does the `[bash-done …]` notice.

Each Command log file is capped at `commandLog.maxBytes`. When more output arrives after the log fills, the log moves to `<log>.1` and replaces the previous `<log>.1`. After a rotation, the marker and the notice name both kept files as the latest output.

### Prelude imports

Each `prelude.imports` entry must follow these rules:

- The entry is a single absolute `import …` or `from … import …` statement, without `*`. pi-ipython skips any other entry and warns you.
- If an import fails when the Kernel starts, such as when the package isn't installed, you get a warning and the other imports still run.

## Packaging and publishing

pi loads `src/index.ts` directly, so the package needs no JavaScript build or bundling step. The npm tarball includes the Python runtime sources and the uv lockfile. uv sets up the Kernel environment separately.

```bash
npm pack --dry-run  # inspect the file list
npm pack            # create pi-ipython-<version>.tgz
```

To try the exact packaged contents before you publish, extract the tarball to a temporary directory and point pi at its `package/` directory:

```bash
scratch=$(mktemp -d)
tar -xzf "$(npm pack --silent)" -C "$scratch"
pi -e "$scratch/package"
```

### Automated npm releases

[The GitHub Actions workflow](.github/workflows/npm.yml) runs type checks and the TypeScript and Python tests, then uploads the npm tarball:

- Pull requests and pushes to `master` only build.
- A pushed tag such as `v0.5.1` publishes that same tarball after the checks pass. The workflow then creates a GitHub Release from the matching section of `CHANGELOG.md`.
- The tag must match `package.json`, and the changelog section must not be empty.

For the full release runbook and recovery steps, see [docs/agents/publishing.md](docs/agents/publishing.md).

#### One-time setup

Do these steps once per package:

1. If `pi-ipython` doesn't exist on npm yet, have an npm owner publish the first version manually with `npm publish --access public`. The package settings exist only after the first publish.
2. In the npm package settings, add a [trusted publisher](https://docs.npmjs.com/trusted-publishers/). Select **GitHub Actions**, and set these values:
	- Owner: `hiennguyen9874`
	- Repository: `pi-ipython`
	- Workflow filename: `npm.yml`
	- Environment: `npm`
3. Under **Allowed actions**, turn on `npm publish`. Allowing only `npm stage publish` is not enough.
4. Create an environment named `npm` in the GitHub repository.

The workflow uses OIDC and doesn't need an `NPM_TOKEN` secret.

#### Each release

1. Bump `package.json` and `package-lock.json` together, for example with `npm version patch --no-git-tag-version`. Use a version that isn't published yet.
2. In `CHANGELOG.md`, move the release notes under a versioned heading such as `## [0.5.1]`.
3. Merge those changes.
4. Create and push the tag on the merged commit:

	```bash
	git tag v0.5.1  # must match package.json on this commit
	git push origin v0.5.1
	```

## License

MIT. Includes code from Unharnessed, Prime Intellect, and Mario Zechner. See `LICENSE` and `NOTICE`.
