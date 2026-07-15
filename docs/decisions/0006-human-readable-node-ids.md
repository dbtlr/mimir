---
title: 'ADR 0006: Human-readable node IDs (project key + per-project sequence)'
status: accepted
date: 2026-06-03
---

# ADR 0006: Human-readable node IDs (project key + per-project sequence)

> **Refined 2026-07-13 by MMR-198.** The original SQLite-era decision below is
> retained as history. The refinement at the end replaces the surrogate-PK and
> stored-counter mechanics: the canonical stem is now the sole identity.

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

## Refinement (2026-07-13, MMR-198): the canonical stem is the sole identity

SQLite retirement removed the foreign-key and cascade mechanics that justified a
second, surrogate identity. The Norn vault persists no integer id; the previous
Norn adapter recreated integers on each load, used them as snapshot-local join
handles, then translated them back into stems for every vault operation. A value
that can change on the next load is not an entity identity.

- **One persisted identity.** A project's immutable `key` is its identity; it has
  no separate `id`. A node's `KEY-seq` stem is its `id`. Parent links, dependency
  endpoints, tag keys, and artifact links carry the same canonical stems through
  the core model and Store seam. Artifacts and seeds keep their existing
  `KEY-aN` / `KEY-sN` stem identities.
- **`seq` remains a component, not a competing identity.** Norn allocates it at
  creation; Mimir retains the number for allocation semantics and explicit
  numeric ordering. Identity never supplies ordering implicitly.
- **Path locates; stem identifies.** Norn point reads resolve a unique stem, while
  atomic apply operations remain path-addressed. The Norn adapter therefore keeps
  the actual `stem → path` locator in its transaction snapshot. Paths never enter
  domain logic, and relocating a document inside the vault does not change its
  Mimir identity. Only creation chooses the canonical `KEY/...` destination.
- **Pending creates have no provisional identity.** A writer-private handle may
  correlate a planned create with Norn's apply report, but it never enters the
  WorkingSet, durable record, domain contract, or public result. The structured
  report's resolved stem becomes the created entity's identity directly.
- **Duplicate stems are corruption.** If multiple work-state documents have the
  same canonical stem, the tolerant reader chooses neither rather than selecting
  one by scan order; doctor reports every colliding path.

Every public surface already speaks these stems, so the refinement changes no
CLI, MCP, HTTP, or UI identity contract. It removes the obsolete internal
translation layer and supersedes the original rejection of stem-keyed relations,
whose cascade concern belonged to the retired SQLite schema.

## Refinement (2026-07-15, MMR-197): scope the never-reuse guarantee to Mimir operations

The original decision above rejected `MAX(seq)+1` allocation ("reuses dead numbers
and breaks references; use a stored per-project counter") on the strength of a
stored counter that no longer exists. The Norn substrate ([ADR
0016](0016-norn-vault-system-of-record.md)) removed the counter — there is **no
`last_seq`** in the vault — and Norn now allocates the creation `{{seq}}` token as
max+1 over the target directory's existing documents (MMR-196 routed artifact and
seed creates through the same token). That is precisely the derive-max mechanism
the original text rejected, adopted silently. This refinement scopes the claim to
match the mechanism rather than pretending the counter survived.

- **Never-reuse holds for Mimir-driven operations.** Mimir verbs never delete a
  document — abandonment is a lifecycle transition ([ADR
  0001](0001-task-status-two-axes-derived-rollup.md)), and the abandoned node keeps
  its seq. So no Mimir operation ever frees a number for max+1 to hand back, and
  the guarantee the original rationale wanted — a `KEY-seq` reference stays stable
  forever — still holds under derive-max for every number Mimir itself allocated.
- **`{{seq}} = max+1` is the current allocation mechanism.** Per-project, per-kind
  (node / artifact / seed each get their own sequence), 1-based, resolved by Norn
  at apply time from the surviving sibling documents. No durable counter backs it;
  the vault's documents are the allocation state.
- **Hand-deletion reuse is the accepted, surfaced edge.** A hand `rm` of an
  interior document frees its number, and the next create re-hands it — the one way
  a seq is reused. In a single-user vault that deletion is intentional; rather than
  prevent it (a stored high-water mark or a Norn monotonic allocator were both
  rejected as relocating the durable-state problem the vault's git history already
  solves), Mimir surfaces it: an interior gap is durable deletion evidence,
  reported by the `mimir doctor` interior-seq-gap check, and recoverable by `git
revert`. See the refinement to [ADR 0017](0017-runtime-data-tolerance.md). The
  delete-max-then-create case closes its own gap and is knowingly undetectable.
