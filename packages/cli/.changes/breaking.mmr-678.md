- **Add checklist items on tasks (MMR-678).** `item add <task> "text"` adds an open numbered item to a task, `item check <task> N` marks it done, and `item drop <task> N "reason"` marks it as not to be done. Checked and dropped items are final. Each subcommand returns the task's whole checklist, and the MCP tools are `item_add`, `item_check`, and `item_drop`.
- **Show items on a task's `get`.** `get <task>` carries `items` in `json` and `jsonl`, shows a count by state in `records`, and `--col items` lists each item. Items are allowed on a task in any status and gate nothing.
- **Carry items in the store export.** The transfer document is schema version 12 and holds `checklist_items`; import refuses an item that breaks a checklist rule, and `doctor` reports it as `invalid-checklist-item`. Migration 0018 adds the `checklist_item` table.

### Migration

**Affected surface.** Engine and tRPC clients, the CLI and MCP surface, the store schema, and store export and import.

**Why.** A task needs a list of small follow-ups that can be checked off, which annotations and child tasks cannot give.

**Before and after.** Engine gains `itemAdd`, `itemCheck`, and `itemDrop`, and a task's `getNode` carries `items`. The store schema moves to version 18, and the transfer document to version 12. An export of version 11 or older imports with no items.

**Steps.**

1. Upgrade the host before its clients, so the store reaches schema 18 first.
2. Regenerate Engine adapters from the contract snapshot.
3. Re-export any store backup that a version 11 binary must read, or import it with this build.

**Validation.** Run `mimir item add <task> "text"`, then `mimir get <task> --col items`, and `mimir doctor`; the doctor reports no `invalid-checklist-item` finding.
