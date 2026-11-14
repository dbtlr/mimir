- **Add delivery records (MMR-676).** Record a phase attempt with `create delivery --phase`, read it with `deliveries` or `get KEY-dN`, and replace its terms with `update`. Both stores preserve delivery records, history, and sequence allocation through export and import.

### Migration

**Affected surface.** Engine and tRPC consumers, CLI and MCP command descriptors, store schema 15, and transfer schema 9.

**Why.** Deliveries are project-anchored records with their own identities and terms.

**Before and after.** The Engine gains `deliveryCreate`, `getDelivery`, `deliveries`, and `deliveryUpdate`. Transfer documents gain deliveries and the delivery counter.

**Steps.** Update the host before its clients. Host startup migrates hosted stores; local SQLite stores migrate on open. Regenerate Engine adapters and transfer readers against the new schemas.

**Validation.** Create a phase and delivery, read and update the delivery, then export and import into a throwaway store.
