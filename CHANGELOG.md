# Changelog

## [Unreleased]

### Fixed

- Config reports inherited property names as unknown keys instead of failing to load, and rejects Python versions below the runtime's minimum (3.11) so defaults apply.

- Kernel pipe errors fail the Cell instead of crashing pi; a later Cell can start a fresh Kernel.
- Bootstrap locks are published with their owner atomically, reclaim stale locks with identity checks, and recover abandoned ownerless directory locks.

### Added

- Config: `<agentDir>/pi-ipython.json` (global) merged with `.pi/pi-ipython.json` (project), project values winning per key. Keys: `confirmEachCell`, `python.source` (`uv` | `project`), `python.version`, `output.maxBytes`, `output.maxLines`. Invalid files, values, and unknown keys are reported with the file and key and skipped, so defaults apply. `python.source: "project"` runs the Kernel with `<cwd>/.venv`'s Python and the vendored runtime on `PYTHONPATH`. (#4)
- `ipython` tool, the only active tool while the extension is loaded. Each call runs one Cell in a persistent Kernel (`python -m rlm.repl`, REPL protocol v3) started lazily in the session cwd; the result carries stdout, labelled stderr, the trailing expression's repr, errors with tracebacks, and the duration. (#3)
- Kernel bootstrap: a uv-managed venv (Python 3.13) built from the vendored runtime's lockfile on first use, rebuilt when the runtime changes, guarded by a directory lock. Location: `<agentDir>/pi-ipython/kernel-venv-<version>`, overridable with `PI_IPYTHON_VENV_DIR`. (#3)
- Kernel client ported from Unharnessed's pre-Rust host: spawn, `ready` handshake, JSONL framing with frame validation, routing by Cell id, interrupt on abort, shutdown. (#3)
- Pi package skeleton: `package.json` manifest with an empty extension entry (`src/index.ts`). (#2)
- Vendored Kernel runtime (`rlm`) from Unharnessed `fe2cf281` under `runtime/`, with its pytest suite run under uv (Python 3.13). (#2)
- Integration test harness (`test/harness.ts`): a real pi SDK session with pi-ipython loaded through extension factories and a faux model. (#2)
- `npm test` runs vitest and the runtime's pytest suite together. (#2)
- `LICENSE` and `NOTICE` crediting Unharnessed, Prime Intellect, and Mario Zechner. (#2)
