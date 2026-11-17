# The first Cell after a Kernel replacement does not run

When the Kernel is replaced without the model already knowing (it died while idle, or the user killed a busy Kernel), the next Cell does not run. Its tool result is an error that carries the State-loss notice, and the model has to resubmit. Running the Cell in the fresh Kernel and adding the notice to its result would be cheaper by one round trip. But that Cell was written assuming the old Python state still existed, and it could run against only part of that state (for example by recreating a cache, or writing files based on missing variables) before the model learns the state is gone. The model knowing what it has lost matters more than one round trip. A Cell whose own run killed the Kernel is never replayed, because it may have had side effects.

## Consequences

- When the notice was already delivered, nothing is blocked: either the Cell that was running when the Kernel died returned it, or a session-level message arrived at the start of a turn (new/resume/fork session, `/tree` restart).
- This replaces the earlier busy-kill behaviour, where the pending Cell ran in the new Kernel with `KERNEL_RESTART_NOTICE` added at the start of its result.
