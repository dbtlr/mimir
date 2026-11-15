- **Read decisions and cap filters (MMR-690).** Add `decisions` to CLI and MCP and `listDecisions` to Engine and tRPC. Read provisional decisions by default, filter by lifecycle, alternative classes, delivery, and linked non-abandoned tasks, in decision sequence order.
- **Count provisional decisions in overview (MMR-690).** Show every provisional decision in the project, including those outside the cap subset.

### Migration

**Affected surface.** Engine, tRPC, CLI, MCP, and overview reports.

**Why.** Decision reads and the cap query need a shared contract across transports.

**Before and after.** Engine gains `listDecisions`. Overview gains `provisionalDecisions` in Engine and `provisional_decisions` in CLI and MCP JSON. No store migration is required.

**Steps.** Upgrade the host before clients. Regenerate Engine adapters from the contract snapshot and add the provisional count to overview fixtures.

**Validation.** Run `decisions --class product --class architecture --linked` and compare overview's provisional count with the unfiltered default `decisions` total.
