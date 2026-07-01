---
title: 'ADR 0015: Project archive — a frozen, hidden, reversible project state'
status: accepted
date: 2026-07-01
---

# ADR 0015: Project archive — a frozen, hidden, reversible project state

A project gains an **`archived`** state: a stored, operator-set fact that makes the project and its whole subtree (nodes + artifacts) _go away_. Archived is two behaviors at once, plus a reversal:

- **Frozen** — no mutation is permitted on an archived project or any descendant (lifecycle, hold, structure, data, create, tag, attach — all rejected).
- **Hidden** — the project, its subtree, and its artifacts drop out of _every_ default read (`next`, `list`, `tree`, `get`, `status`, the Overview). They are reachable only through one deliberate door: a `--status archived` selection.
- **Reversible** — `unarchive` restores the project; archive is never a delete.

Archive **replaces** any notion of hard-deleting a project. The store's DB file is no longer the only way to make a whole project leave the operator's world.

- **`archived` is a stored _operator axis_, not a derived rollup.** It lives as a nullable `project.archived_at` timestamp (`NULL` = active). This does not violate "non-leaf nodes / projects store no status" (ADR 0001/0008): that rule forbids storing a **derived rollup** word, because a rollup is a pure function of children and a stored copy is a sync surface. Archived is **not derivable** — a project full of active, ready work can still be killed because the effort is superseded — so it cannot drift and is not a rollup cache. It is the project's first stored operator axis, analogous to a task's stored `lifecycle`/`hold` axes.
- **Inherited, never cascade-written.** The flag lives only on the project row; the subtree and artifacts inherit archived-ness at query and guard time via `project_id`. Archive is one write (O(1)), with no per-node state to drift.
- **Enforced in core.** Both the read-hiding (a core query default) and the write-lock (a core mutation guard) live in the core layer, so CLI, HTTP, and MCP inherit them (ADR 0010). Hiding is not a per-consumer convention — a consumer that forgets to filter would leak an archived project.
- **Reason-bearing, so the transition log generalizes.** Archive/unarchive are status-bearing transitions carrying a reason ("superseded by …"); by ADR 0003 the reason rides the log row. The `transition_log` is generalized from node-keyed to **entity-keyed**: `node_id` becomes nullable, a nullable `project_id` is added, an XOR check enforces exactly one, and `kind` gains `'archive'`. Node-history reads (`WHERE node_id = ?`) are unchanged.

## Why

- **Reads the invariants for what they protect.** ADR 0001's "store no status" targets _derived rollup_ state (a drift-prone cache). Archived is an un-derivable operator decision, so storing it introduces no cache and no drift — it is a work-state _fact_, which is exactly what the spine says Mimir stores.
- **Append-only is honored, not bent.** Archive is a reversible transition (set/clear a flag, append a log row), not a destructive delete. The one schema growth — a project-referencing transition log — is append-only's _additive_ direction, in the spirit of ADR 0003, never the destructive one.
- **A single choke point makes freeze cheap and leak-proof.** Every mutation already resolves its target's `project_id`; the write-lock is one predicate there. Enforcing hiding as a core query default (not per-transport) means no surface can individually forget it.
- **Inheritance beats cascade.** Storing archived once and deriving the subtree's archived-ness matches the derive-don't-store principle and the inherited-dependency precedent; a cascade write would be O(n) and reintroduce a drift surface.

## Considered and rejected

- **A guarded hard `--force` delete** (for genuinely erroneous projects) — violates append-only (ADR 0003) and is redundant: archive already removes a project from the operator's world, reversibly. The one capability delete would add — freeing an immutable `--key` for reuse — is deferred as YAGNI.
- **Archived as a tag** (`archived` on the project) — a tag is the wrong tool: for archived to declutter default views, the core must _act_ on it, but Mimir never interprets tags (ADR 0002/0005). A tag would force either a core exception (naming a specific tag) or leave hiding to per-consumer convention (a forgotten filter leaks the project).
- **A one-way archive (no `unarchive`)** — a one-way door is a hard-delete in disguise; reversibility is cheap, append-only-clean, and undoable, and it is what makes hard-delete unnecessary.
- **Cascade-stamping every descendant node** — O(n) per archive and a drift surface; superseded by project-level storage + inheritance.
- **Column-only, no reason** (bare `archived_at`, no log row) — loses the _why/when/how-many-times_ history and departs from the reason-bearing lifecycle verbs; the transition-log generalization is small and keeps the audit trail whole.

## Consequences

- **Schema:** `project` gains a nullable `archived_at`. `transition_log` becomes entity-keyed (`node_id` nullable, new nullable `project_id`, XOR check, `kind` gains `'archive'`, add `idx_transition_project`).
- **Verbs:** `archive <KEY> [reason]` and `unarchive <KEY>` — project-only (bare `KEY`). Idempotency (archiving an already-archived project) resolves to a usage/invariant error.
- **Reads:** the default universe excludes archived projects, their subtrees, and their artifacts across all read paths; `--status archived` is the sole opt-in. Direct `get`/`status`/`tree` on an archived subtree resolve as `not_found` without the opt-in.
- **Writes:** a core guard rejects any mutation whose owning project is archived.
- **Refines [ADR 0001](0001-task-status-two-axes-derived-rollup.md)/[0008](0008-state-word-projection-and-interpret-cascade.md):** "projects store no status" is sharpened to "projects store no _derived_ status" — an un-derivable operator axis (archived) is permitted.
- **Refines [ADR 0003](0003-append-only-transition-log.md):** the transition log keys on an entity (node or project), not a node alone.
- **Glossary:** adds **Archived**; refines **Project** (no longer "status is not meaningful") and **Transition log** (entity-keyed).
- No consumer-facing change is required for correctness beyond core: transports inherit the guard and filter.
