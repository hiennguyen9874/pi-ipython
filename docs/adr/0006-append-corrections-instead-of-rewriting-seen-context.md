# Append corrections instead of rewriting context the model has seen

Provider prompt caches reuse the longest prefix that matches the previous request, so a change to anything a request already carried makes the cache useless for everything after it. pi-ipython therefore never edits or removes a message once a request has carried it. When an earlier notice turns out to be wrong, a later message corrects it. For example, a Python-state notice whose Kernel died stays in the context, and the State-loss notice that follows it says the state is gone. A message no request has carried yet can still be dropped or replaced. This follows Unreal Agent's committed-prefix/staged-suffix split, applied to pi's messages instead of to tool results.

## Considered Options

- **Rewrite for accuracy**: remove stale notices from later requests, so the context never says something false. The model gets a cleaner context, but every rewrite costs a full cache miss, and the State-loss notice already tells the model what changed.
- **Freeze the `ipython` tool description too**: fix the description after the first request and announce Pi tools that appear or disappear later with an appended message. Rejected because the callable set rarely changes after the first request (MCP servers usually connect before it), so the saving does not pay for the extra state and the stale description.

## Consequences

- Exception: the `ipython` tool description still changes whenever the callable Pi tool set changes (late MCP connections, tools toggled mid-session), and that costs one cache miss each time. It must not change for any other reason; a test pins it byte-for-byte while the callable set stays the same.
- The system prompt is forced and fixed for each run (ADR 0005), and the wording must stay the same from one run to the next unless the config or skills change.
