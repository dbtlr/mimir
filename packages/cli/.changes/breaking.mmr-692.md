- **Read what changed on a delivery with `get KEY-dN --since <instant>` (MMR-692).** The answer is `{ delivery, since, as_of, events }`: the delivery as `get` reads it, the cursors, and every event strictly after `since` (the delivery's history and lists, its members' transitions, notes, and checklist items while they were members, its decisions, and its frozen run journal), oldest first. Each event has an `id` and the fields `at`, `record`, `kind`, `task`, `number`, `from`, `to`, `reason`, and `text`. Pass `as_of`, which lags the clock by 5 seconds, as the next `--since` and drop ids already seen.
- **Accept `--since` only on a delivery id.** On any other id it is a usage error that names the list reads (`list`, `next`, `artifacts`, `seeds`) whose `--at-or-after` windows a list. The retired `--since` stays retired on every other command, and a value that is not a zoned ISO 8601 instant is a usage error before the store opens. The MCP `get` tool takes `since` with the same rule.

### Migration

**Affected surface.** Engine and tRPC clients, and the CLI and MCP `get` surface.

**Why.** An orchestrator's heartbeat and an agent before close-out need what changed on a delivery since their last look, without storing a cursor in Mimir.

**Before and after.** Engine gains the query `deliverySince({ id, since })`, and `get` gains `--since` and the MCP `since` input. Nothing is stored and no store migration is needed. `--since` on a command other than `get KEY-dN` still fails as it did.

**Steps.**

1. Upgrade the host before its clients, so a remote client's `deliverySince` has a server to answer it.
2. Regenerate Engine adapters from the contract snapshot.
3. Poll with `get KEY-dN --since <instant> -f json`, pass each answer's `as_of` back, and drop events whose `id` you have seen.

**Validation.** Run `mimir get <delivery> --since 2000-01-01T00:00:00Z -f json` and see the delivery's events; run it again with the answer's `as_of` and see the overlap with the same ids.
