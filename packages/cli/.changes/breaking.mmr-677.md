- Add decision records with `decide`, `confirm`, and `overturn`, task links and delivery references through `update KEY-qN`, and full records through `get KEY-qN`. Task detail reads include linked decisions. Overturn annotates every linked task atomically.

### Migration

**Affected surface.** Engine, tRPC, CLI, MCP, store schema and transfer documents.

**Why.** Provisional answers need durable records that the operator can settle.

**Before and after.** Engine gains `decide`, `getDecision`, `decisionUpdate`, `confirm`, and `overturn`. Task `get` gains `decisions`. Store schema 17 adds decisions, links, history and a project counter. Export schema 11 carries decisions; older exports default to no decisions.

**Steps.** Upgrade the host before clients and regenerate Engine adapters from the contract snapshot. Reopen local stores to migrate them.

**Validation.** Record a decision, link a task, read both, and confirm or overturn the answer. Check that an overturn annotates all linked tasks and terminal decisions refuse writes.
