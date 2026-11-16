- **Link a delivery's follow-up tasks and seeds (MMR-693).** `update KEY-dN --follow-up ID` and `--unfollow-up ID` repeat and work in any lifecycle. Tasks stay on the delivery's board; seeds may be cross-board. `get` and update echoes carry the standing `follow_ups`; since reads include `follow_up` events. Archived projects hide linked records and events.
- **Preserve link history in transfer.** Migration 0021 adds `delivery_follow_up`; export version 14 carries retained link rows. Import and doctor validate references, standing uniqueness, and canonical timestamps.

### Migration

Upgrade the host before clients. Regenerate Engine adapters: `deliveryUpdate`
now returns the detail view, and delivery events admit `follow_up`.
The current unreleased version window remains `0.29.0-next`.
Older exports import without follow-up links. New exports require a binary
that reads schema version 14. Validate with `get KEY-dN -f json` and `doctor`.
