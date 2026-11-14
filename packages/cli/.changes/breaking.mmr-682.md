- **Reserve tasks with delivery membership (MMR-682).** Delivery creation sweeps eligible tasks or selects repeated `--task` ids. Join and leave with `update --delivery`. Queue, move, done, staged leave, and staged abandon enforce the reservation: `done` refuses a member, which finishes when its delivery lands. Reopen clears a task's delivery reference. Import refuses, and doctor reports, a delivery reference no verb produces. Task and delivery reads expose membership and its ordered history.

### Migration

**Affected surface.** Engine, tRPC, CLI and MCP descriptors, store schema 16, and transfer schema 10.

**Why.** Membership reserves unclaimed work for one delivery.

**Before and after.** Tasks gain nullable `delivery`, delivery views gain `members`, and delivery creation accepts optional `tasks`. Creation now joins eligible phase tasks by default. `done` on a member now refuses; leave first with `update <task> --delivery none` to finish it alone.

**Steps.** Update the host before its clients. Stores migrate on open or host startup. Regenerate Engine adapters against the new snapshot.

**Validation.** Create a delivery with phase tasks, leave and rejoin a task, verify queue refusal, and round-trip members through export and import.
