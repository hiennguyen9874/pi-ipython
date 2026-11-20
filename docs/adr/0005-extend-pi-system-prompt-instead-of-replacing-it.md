# Extend pi's system prompt instead of replacing it

pi-ipython no longer builds its own system prompt. In `before_agent_start` it takes the prompt pi and earlier handlers have rendered (`event.systemPrompt`), inserts an `<ipython>` section before `<docs>` and a `<skills>` section before `<cwd>`, and returns the result as `systemPrompt`. Replacing the prompt silently dropped `SYSTEM.md`, `APPEND_SYSTEM.md`, and every other extension's prompt changes. Inserting at pi's own section markers keeps them and puts the REPL instructions where pi's tool guidance belongs.

## Considered Options

- **Tool `promptSnippet` and `promptGuidelines` only**: pi's own mechanism, but rules are flat bullets that cannot hold the `bash()` API reference, and `SYSTEM.md` (`customPrompt`) replaces the whole `<tools>`/`<rules>` block, so the model would lose the REPL instructions.
- **`systemPromptOptions.sections`**: no forcing, and pi patches only changed sections. But pi appends extension sections after `<cwd>`, and any handler that forces the prompt before or after us drops them, which the user's own extensions do.
- **Insert per request in `context_with_system`**: always current, but `ctx.getSystemPrompt()` and prompt dumps never show the REPL instructions.

## Consequences

- The prompt is forced, so it stays fixed for the whole run and pi's per-section patching is off. Everything that can change within a run (whether any Pi tool is callable, and the `pi` API) is in the `ipython` tool description, which `prepareLoadout` refreshes every turn.
- An extension that runs after pi-ipython and changes `sections` or `promptGuidelines`, or returns a prompt that ignores `event.systemPrompt`, loses the other's changes. Extensions that edit `event.systemPrompt` compose in either order.
- The session transcript records pi's structured prompt without the inserted sections. `ctx.getSystemPrompt()` during a run returns the forced text.
