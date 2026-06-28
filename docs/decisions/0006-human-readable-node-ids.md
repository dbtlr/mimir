---
title: 'ADR 0006: Human-readable node IDs (project key + per-project sequence)'
status: accepted
date: 2026-06-03
---

# ADR 0006: Human-readable node IDs (project key + per-project sequence)

Work nodes get a Jira-style human reference ID, layered on top of the surrogate primary key:

- **Project key** — every project has a **globally unique, immutable** key matching `[A-Z]{2,4}` (e.g. `MMR`, `SAGA`, `PRD`, `VAL`), **consumer-supplied at creation** and Mimir-validated (format + uniqueness).
- **Node seq** — every **work node** under a project (initiative, phase, task — the whole typed tree, _not_ tasks only) carries a **`seq`**: a per-project, monotonic, **never-reused** allocation number, assigned at creation and immutable.
- **Rendered ID** — the human/reference ID is `KEY-seq` (e.g. `MMR-16`), **derived** as `project.key + '-' + seq`, not stored.
- **Layered on the PK, not replacing it.** The surrogate `id` remains the sole internal identity — every FK, `parent_id`, and artifact link uses `id`. The human ID is for display and cross-reference; lookups accept **either**.

## Why

- **"Locate the project from the ID alone."** Global key uniqueness + embedding the key in every node's reference makes project membership legible at a glance — the one genuinely useful Jira convention.
- **All nodes, not tasks-only**, share the sequence, so _everything_ is addressable (you can cite an initiative `MMR-3` in a session log), matching Jira's shared key space; the typed tree already treats nodes uniformly.
- **`seq` is stored _allocation_, not stored _derived state_.** A non-reusing monotonic ID can't be derived — `MAX(seq)+1` reassigns the numbers of deleted/abandoned nodes and breaks stable references. This is categorically distinct from "derive, don't store" ([ADR 0001](0001-task-status-two-axes-derived-rollup.md)), which forbids caching _derived predicates_, not _allocated identities_ (it's a per-project autoincrement).
- **Immutability keeps references stable forever;** burning a number on delete/abandon matches the append-only / keep-`abandoned` ethos.

## Considered and rejected

- **Tasks-only `KEY-N`** (the initial framing) — leaves initiatives/phases addressable only by opaque internal `id`; all-nodes is uniform and complete.
- **Deriving the number as `MAX(seq)+1`** — reuses dead numbers and breaks references; use a stored per-project counter.
- **Human ID as the primary key / baked into FKs** — renames or moves would cascade through the whole graph; the surrogate PK stays the identity.
- **Mutable project key / cross-project moves that keep the number** — would orphan or confuse `KEY-*` references. Key is immutable; cross-project `move_node` is disallowed for now (revisit by minting a fresh ID if ever needed).

## Consequences

- `project` gains `key` (unique, `[A-Z]{2,4}`, immutable). The node spine gains `seq` (per-project, immutable, allocated at creation).
- A per-project allocation counter (e.g. `last_seq` on the project), atomically incremented at node creation; never decremented or reused.
- `create_*` validates the key / allocates the `seq`; the rendered ID is `key + '-' + seq`; lookups resolve either `id` or `KEY-seq`.
- Cross-project `move_node` disallowed for now (would break the embedded key).
- Orthogonal to `external_ref` (outward GitHub linkage) — this is Mimir's own internal-but-human identifier.
