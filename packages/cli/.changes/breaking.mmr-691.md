- **Add known limitations and declined findings on a delivery (MMR-691).** `limitation KEY-dN "text"` records an edge case a delivery ships knowingly, and `decline KEY-dN "finding" "reason"` (or `--reason`) records a review finding it chose not to act on. Entries are numbered together per delivery, never edited, and accepted in any delivery lifecycle. The MCP tools are `limitation` and `decline`.
- **Show them on `get KEY-dN`.** `json` and `jsonl` always carry `limitations`, `declined`, and `journal`, and `records` prints each non-empty list and a `journal` line.
- **Let a Scratchpad be a delivery's run journal.** `scratch create --link KEY-dN` and `scratch update --link KEY-dN` take one delivery id. Freeze names the delivery on the artifact and links every task that was ever a member. Scratchpad and artifact views carry `delivery`, and a delivery has at most one live pad.
- **Carry them in the store export.** The transfer document is schema version 13 and holds `delivery_findings` and the `delivery` of pads and artifacts. Import refuses, and `doctor` reports as `invalid-delivery-finding` or `invalid-run-journal`, an entry or journal reference that breaks a rule. Migration 0019 adds the `delivery_finding` table and the `delivery` columns.

### Migration

**Affected surface.** Engine and tRPC clients, the CLI and MCP surface, the store schema, and store export and import.

**Why.** A build's delivery needs a record of what it ships knowingly and what it declined, and a run journal that outlives the delivery.

**Before and after.** Engine gains `deliveryLimitation` and `deliveryDecline`; `getDelivery` carries `limitations`, `declined`, and `journal`; and scratchpad and artifact views carry `delivery`. The store schema moves to version 19, and the transfer document to version 13. An export of version 12 or older imports with no entries and no journal delivery.

**Steps.**

1. Upgrade the host before its clients, so the store reaches schema 19 first.
2. Regenerate Engine adapters from the contract snapshot, and read the new `delivery` field on scratchpad and artifact views.
3. Re-export any store backup that a version 12 binary must read, or import it with this build.

**Validation.** Run `mimir limitation <delivery> "text"`, then `mimir get <delivery> -f json`, and `mimir doctor`; the doctor reports no `invalid-delivery-finding` or `invalid-run-journal` finding.
