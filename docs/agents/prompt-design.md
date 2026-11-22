# Prompt design

Optimize for the model’s decisions, not for the shortest prompt. Fix incorrect choices, missing fallbacks, and premature completion before tuning token cost or latency.

## 1. Inspect the rendered request

Read what the provider receives: the assembled system prompt, tool names, descriptions and schemas, and the results or notices the model acts on. A template or default fixture can miss a host override, a stale tool list, or a rule absent in another mode. For pi-ipython, start with [prompt assembly](../../src/prompt/system-prompt.ts), [tool metadata](../../src/tool/ipython-tool.ts), and the [provider-facing tests](../../test/prompt.test.ts). Before editing, save the rendered baseline and name the failure you can observe; for a new prompt, name the decisions it must get right.

## 2. Give each rule one owner

Use the narrowest surface the model can reliably reach **before** it needs the rule. “Tool prompt” means guidance for using a tool; the host may deliver it as guidelines, a system-facing snippet, or part of the description.

| Surface | Put here |
| --- | --- |
| System prompt | The minimum operating model, task-wide priorities, workflows that span tools, and what counts as done. |
| Tool prompt | When to choose this tool over an alternative, what to check first, call order, and what to do with its result. If the host separates the snippet from the description, use the snippet for selection. |
| Tool description and schema | A short capability statement that distinguishes the tool, its actual inputs and outputs, and consequential limits or side effects. Put field-specific rules beside the field, such as escaping in `code`. Reflect what is callable now. |
| Runtime result or notice | What happened, which operation or state it concerns, and the next safe action. A notice can teach recovery on arrival; it cannot tell the model in advance whether it is safe to wait for that notice. |
| On-demand lookup | Full signatures, rare options, and inventories. Put the lookup trigger at the decision it supports. |

Apply [the host composition decision](../adr/0005-extend-pi-system-prompt-instead-of-replacing-it.md) and [the rule ownership decision](../adr/0007-each-prompt-rule-lives-in-one-layer.md). Preserve user and extension text when adding a section. Assemble named fragments under explicit conditions rather than matching English sentences; check real section boundaries and fallback placement. Derive inventories from live state or configuration instead of maintaining a second list. Disabling optional advice must leave required fallback behavior visible.

## 3. Sequence by dependency

Introduce the minimum operating model, then put prerequisites before calls and verification before reporting. Keep each decision together: **trigger → action → completion evidence**. Cover the unavailable, delayed, and failed paths alongside the normal one. Examples should show the check, not just the invocation: an install example checks the command result before trying the import.

- **Start → work → collect → verify.** A live `BashHandle`, a completed `BashResult`, and a successful Cell are different. A Cell can succeed while its command fails; check the command’s `exit_code` before reporting success. While safe independent work remains, keep the handle and do that work. If a required result has no usable resume path, `await` the handle and check it in this turn. If a notice can resume the task and nothing else can proceed, say what is pending and verify on resumption. A notice may be batched, delayed, or paused. A one-off status check is not a wait loop.
- **Fan out → collect.** Parallelize only when there is neither a data dependency nor a resource conflict. Two readers can share an input; two writers to the same build directory cannot safely overlap just because neither needs the other’s result. Order dependent work so a failed prerequisite blocks its dependents.
- **Find → describe → call.** When a listing is partial, say so and point to the available lookup. When the listing lacks a complete call contract, retrieve the schema, guidelines, and return shape before the first call. Batch read-only discovery when supported; measure schema errors as well as latency before relaxing that prerequisite.
- **Recover → continue.** For truncated output, narrow the query or inspect the Spill file if one was saved. After partial failure or state loss, check which external effects already happened; rebuild needed Kernel state before resuming rather than replaying everything.

Use familiar, consistent terms for distinct types and states. Lead with the action to take; reserve prohibitions for hard boundaries or demonstrated regressions, and pair them with the desired action. Where possible, enforce machine-checkable rules in the runtime. Prune stale copies and cheap lookups once the workflow is clear. Treat deleting, moving, or softening a guardrail that fixed a real failure as an ablation, not a copyedit.

## 4. Verify delivery, then behavior

1. **Delivery:** Inspect provider-facing requests and assert where the rule appears, where it is absent, and what replaces it. Exercise changed switches in combination, not just the default. For waiting, cover parallel guidance on/off independently of notice availability, including modes that cannot resume. For tool discovery, check the live loadout and search availability. A fixture or faux provider proves delivery, not compliance.
2. **Behavior:** Compare the exact rendered baseline and candidate on the same real model, settings, and task fixtures. Decide the pass criteria and tolerated regression before running. Repeat runs; score the tool trace and final answer per case and configuration. Keep correctness (false success, abandoned work, bad calls) separate from cost (tool calls, latency, provider-reported tokens). A smaller fixture in bytes is not a token or behavior measurement.
3. **Decision:** Keep the smallest change that fixes the failure without regressing protected cases. If a case regresses, tighten its branch or restore the smallest useful rule at its owner, then rerun that case. If real-model runs are unavailable, report the change as wired but behaviorally unverified rather than calling it optimized.

Choose cases that expose the branch being changed: a nonzero shell exit in a successful Cell; a long command with notices off, paused, or delayed; live-handle methods attempted on a finished result; two commands writing to the same directory; a regex with backslashes; a targeted edit with two matches; truncated output without a Spill file; or Kernel replacement after work with external effects. The original lean-prompt comparison is tracked in [#62](https://github.com/hiennguyen9874/pi-ipython/issues/62).
