# Changelog

## [Unreleased]

### Fixed

- Lifecycle cleanup preserves live hosts with unknown identities, never kills historical process groups without ownership proof, and retains journals after unresolved cleanup. Windows Kernels contain ordinary subprocesses in a kill-on-close job. Explicit new/resume/fork sessions receive a state-lost notice even without earlier Cells. After a POSIX host crash, groups whose leaders have already died are deliberately skipped because their ownership cannot be established safely. (#7)

- Cell output spills are owner-only and preserve the Cell result if saving fails. Background text is preserved in full (including literal truncation markers), keeps its attribution after tail truncation, and background image displays are delivered with the next result. (#5)

- Config reports inherited property names as unknown keys instead of failing to load, and rejects Python versions below the runtime's minimum (3.11) so defaults apply.

- Kernel pipe errors fail the Cell instead of crashing pi; a later Cell can start a fresh Kernel.
- Bootstrap locks are published with their owner atomically, reclaim stale locks with identity checks, and recover abandoned ownerless directory locks.

### Added

- Session lifecycle: `session_start` warms the uv venv in the background (the Kernel still starts on the first Cell). Every `session_shutdown` kills the Kernel and its process group, including subprocesses started by Cells. Kernels are journaled per pi host under `<agentDir>/pi-ipython/journal/`, and Kernels (plus their `bash()` children) left by a crashed host are reaped the next time the extension starts. When a session starts with earlier `ipython` Cells on its branch (resume, fork, reload, `--continue`), the model gets a notice that Python state is gone with its next turn. (#7)
- Forced system prompt: pi's prompt is replaced by an Unharnessed-style REPL prompt (one `ipython` tool, `bash()` handles, no `%magic`/`!cmd`), followed by pi's context files, the skills list with `SKILL.md` paths to read from Python, the current date, and the cwd. (#6)
- Cell output shaping: the result text is truncated to its tail at `output.maxLines` / `output.maxBytes` (pi's 2000 lines / 50KB by default), with the full text spilled to a temp file whose path is in the result. `display` payloads with image MIME types (png, jpeg, gif, webp) become image blocks. stdout/stderr with no owning Cell (threads, subprocesses, tasks of finished Cells) is buffered and appended to the next Cell's result under `[background output]`. (#5)
- Config: `<agentDir>/pi-ipython.json` (global) merged with `.pi/pi-ipython.json` (project), project values winning per key. Keys: `confirmEachCell`, `python.source` (`uv` | `project`), `python.version`, `output.maxBytes`, `output.maxLines`. Invalid files, values, and unknown keys are reported with the file and key and skipped, so defaults apply. `python.source: "project"` runs the Kernel with `<cwd>/.venv`'s Python and the vendored runtime on `PYTHONPATH`. (#4)
- `ipython` tool, the only active tool while the extension is loaded. Each call runs one Cell in a persistent Kernel (`python -m rlm.repl`, REPL protocol v3) started lazily in the session cwd; the result carries stdout, labelled stderr, the trailing expression's repr, errors with tracebacks, and the duration. (#3)
- Kernel bootstrap: a uv-managed venv (Python 3.13) built from the vendored runtime's lockfile on first use, rebuilt when the runtime changes, guarded by a directory lock. Location: `<agentDir>/pi-ipython/kernel-venv-<version>`, overridable with `PI_IPYTHON_VENV_DIR`. (#3)
- Kernel client ported from Unharnessed's pre-Rust host: spawn, `ready` handshake, JSONL framing with frame validation, routing by Cell id, interrupt on abort, shutdown. (#3)
- Pi package skeleton: `package.json` manifest with an empty extension entry (`src/index.ts`). (#2)
- Vendored Kernel runtime (`rlm`) from Unharnessed `fe2cf281` under `runtime/`, with its pytest suite run under uv (Python 3.13). (#2)
- Integration test harness (`test/harness.ts`): a real pi SDK session with pi-ipython loaded through extension factories and a faux model. (#2)
- `npm test` runs vitest and the runtime's pytest suite together. (#2)
- `LICENSE` and `NOTICE` crediting Unharnessed, Prime Intellect, and Mario Zechner. (#2)
