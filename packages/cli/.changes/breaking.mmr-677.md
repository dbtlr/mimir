- **Record provisional answers as decisions (MMR-677).** `decide` records a question the agent answered without stopping, with its options, recommendation, answer taken, and class. `update KEY-qN` links the tasks built on it and its delivery, `confirm` and `overturn` settle it, and `get KEY-qN` reads the whole record. Overturn annotates every linked task in the same transaction. A task's `get` lists its linked decisions.
- **Delivery and decision records show times in your zone (MMR-677).** `get KEY-dN` and `get KEY-qN` records print `created_at`, `updated_at`, and history times in the caller's zone, as task records do. `json` and `jsonl` keep ISO instants.

### Migration

**Affected surface.** Engine, tRPC, CLI, MCP, store schema and transfer documents.

**Why.** Provisional answers need durable records that the operator can settle.

**Before and after.** Engine gains `decide`, `getDecision`, `decisionUpdate`, `confirm`, and `overturn`. Task `get` gains `decisions`. Store schema 17 adds decisions, links, history and a project counter. Export schema 11 carries decisions; older exports default to no decisions.

**Steps.** Upgrade the host before clients and regenerate Engine adapters from the contract snapshot. Reopen local stores to migrate them.

**Validation.** Record a decision, link a task, read both, and confirm or overturn the answer. Check that an overturn annotates all linked tasks and terminal decisions refuse writes.
