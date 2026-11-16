# Changelog

## [Unreleased]

### Added

- Pi package skeleton: `package.json` manifest with an empty extension entry (`src/index.ts`). (#2)
- Vendored Kernel runtime (`rlm`) from Unharnessed `fe2cf281` under `runtime/`, with its pytest suite run under uv (Python 3.13). (#2)
- Integration test harness (`test/harness.ts`): a real pi SDK session with pi-ipython loaded through extension factories and a faux model. (#2)
- `npm test` runs vitest and the runtime's pytest suite together. (#2)
- `LICENSE` and `NOTICE` crediting Unharnessed, Prime Intellect, and Mario Zechner. (#2)
