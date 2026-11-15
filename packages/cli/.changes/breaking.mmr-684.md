- **Apply delivery board rules (MMR-684).** Board-wide next excludes delivery members; next --delivery lists an attempt's ready members in rank order. A submitted or staged prerequisite settles a direct dependency only for another member of the same live delivery, even when held. Blocking and readiness timestamps follow the same rule, with membership history included in ready flip times.

### Migration

**Affected surface.** Engine, tRPC, CLI and MCP next reads.

**Why.** Reserved delivery work belongs to its attempt's queue, and review on the shared branch unlocks its dependents.

**Before and after.** Engine next gains optional delivery. Board-wide next omits members; next --delivery KEY-dN selects ready members. Dependencies remain advisory; start stays ungated.

**Steps.** Update the host before clients and regenerate adapters from the contract snapshot. Use next --delivery to select work in an attempt.

**Validation.** Submit a prerequisite shared with a dependent in one delivery. Confirm the dependent appears in next --delivery and is absent from board-wide next.
