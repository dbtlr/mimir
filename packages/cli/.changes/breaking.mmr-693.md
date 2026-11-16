- **Link a delivery's follow-up tasks and seeds (MMR-693).** `update KEY-dN --follow-up ID` and `--unfollow-up ID` repeat and work in any lifecycle. Tasks stay on the delivery's board; seeds may be cross-board. `get` and update echoes carry the standing `follow_ups`; since reads include `follow_up` events. Archived projects hide linked records and events.
- **Preserve link history in transfer.** Migration 0021 adds `delivery_follow_up`; export version 14 carries retained link rows. Import and doctor validate references, standing uniqueness, and canonical timestamps.

### Migration

**Affected surface.** Engine and tRPC clients, CLI and MCP output, store schema,
and store export and import.

**Why.** A delivery links work it gave rise to, including follow-ups filed after
landing, and retains the history of those links.

**Before and after.** `deliveryUpdate` now returns the detail view, `get` carries
`follow_ups`, and delivery events admit `follow_up`. Store migration 0021 adds
the link table; export version 14 carries its rows. Older exports import without
links. The current unreleased version window remains `0.29.0-next`.

**Steps.** Upgrade the host before clients. Regenerate Engine adapters from the
contract snapshot. Read new exports with a binary that supports version 14.

**Validation.** Link a record with `update KEY-dN --follow-up ID`, inspect
`get KEY-dN -f json`, and run `doctor`.
