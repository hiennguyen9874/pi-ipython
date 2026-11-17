# Compaction never removes Python state

Unharnessed prunes names larger than its per-variable snapshot cap (16 MiB) from the live namespace at compaction. We don't: compaction shrinks the conversation, never the Kernel. Snapshot caps only limit what is written to a snapshot; an oversized name is skipped there and reported to the model, but stays alive in the Kernel. A large dataframe is often the reason a user picked a persistent Python Kernel, so deleting it during an automatic compaction would be a surprising, unrecoverable loss.

## Consequences

- Kernel memory is not bounded by compaction; a restore after restart can bring back less than the live Kernel held, and the restore report must say which names were skipped.
- This deviates from #13 as first written ("pruning of oversized names at compaction").
