# Each prompt rule lives in one layer, loaded when the model needs it

pi-ipython tells the model how to use the Kernel through four layers, and each rule lives in exactly one of them:

1. **`<ipython>` system prompt section** (always loaded, fixed for the run): the Cell and Kernel model, `bash()` and its handle and result, checking `.exit_code`, environments, and the workflow every task needs.
2. **`ipython` tool description** (always loaded, refreshed each turn by `prepareLoadout`): what can change within a run, namely the `pi` API and Spill files. The `code` parameter description owns how to write Cell code (raw strings, `{{ }}` in f-strings).
3. **Runtime notices** (only when the situation happens): the `[bash-done …]` notice says how to read the result, and the State-loss notice says what was lost.
4. **Lookup** (`help()` on an object): full signatures the model rarely needs, such as `.kill(sig, grace)`.

Before #61 the same advice sat in several places (raw strings three times, packages twice), and situation-specific advice cost attention on every turn. Rules state the behaviour to produce rather than the one to avoid, because a prohibition primes the behaviour it forbids. Keep a prohibition only when a real-model eval shows the positive rule alone regresses, and pair it with the target behaviour: "Wait with `await h`, not `sleep` loops."

## Considered Options

- **Keep the guardrails everywhere they were added**: each one fixed a real failure, but the repetition grew the prompt and wording drifted between copies.
- **Move everything into the tool description**: one place, but stable workflow belongs in the `<ipython>` section (ADR 0005), and only the runtime knows the facts a notice carries (exit code, which handle).

## Consequences

- A new rule goes in the earliest layer that is loaded whenever the rule applies, and nowhere else. Tests pin it in that layer only.
- Vitest uses a faux provider, so it proves where a rule is placed, not that a model follows it. Changes that drop or soften a rule need a real-model A/B (#62).
