---
title: "ADR 0007: Rank is the primary order; priority is a signal"
status: accepted
date: 2026-06-04
---

# ADR 0007: Rank is the primary order; priority is a signal

`next_tasks` — the headline "what's next?" tool — orders by a single **rank**, not by priority.

- **Rank is the primary sort and wins over priority** (and every other attribute). An explicit human ordering beats any heuristic, because someone may deliberately place a P2 ahead of a P0 for a reason the system can't see. Sorting by priority would silently override that intent.
- **Priority, size, age, … are orthogonal _signals_** — they _filter_ the queue (`next_tasks` scoped to P0) and _advise_ the human when setting rank, but are never the sort partition. They remain first-class stored facts (not folded into rank) so they can also power future **archaeology predicates** — e.g. `buried`, a high-priority task long stranded low in rank: the rank-aware sibling of [stale](0001-task-status-two-axes-derived-rollup.md). (Not a day-one feature.)
- **Rank is relative, not absolute.** The caller expresses intent as "put x before/after y" (or send-to-top/bottom); the **core owns the underlying numbers** and the caller never sets or reads a rank value. Reprioritizing (changing priority) and reordering (changing rank) are **separate orthogonal operations**; a UI's drag-across-columns gesture composes the two as an envelope convenience, not a new core concept.
- **Rank is dense over the _rankable set_, scoped per project.** A task carries a rank iff `lifecycle ∈ {todo, in_progress}` AND `hold == none`. Terminal (`done`/`abandoned`) and held (`blocked`/`parked`) tasks drop out. Leaving the set clears the rank (leaves a gap, no reindex); entering/re-entering (create / unpark / unblock) appends to bottom. `awaiting` tasks (dep-gated but un-held) stay ranked so they keep their slot.
- **Storage mechanism is a deliberately reversible implementation choice**, not pinned here: integer-with-gaps, fractional/lexorank, or contiguous reindex. Because the numbers are internal and the rankable set is small and project-scoped, the choice is immaterial at single-operator scale — default to the simplest that works.

## Why

- **Honors deliberate human intent.** The whole point of a manual order is to say "this, then that" against the system's own judgment. If priority partitioned the sort, the human could never rank a P2 above a P0 — the most common reason to reach for manual ordering in the first place.
- **One honest order beats a partitioned one.** A single straight list means there is exactly one answer to "what's next," with no precedence rules to reconcile between priority buckets and within-bucket order. Priority-as-columns (the rejected kanban frame) is a _visualization_, not the model — and you'd never actually render priority as columns; columns are **status** or **initiative**.
- **Signals earn their keep without owning the sort.** Keeping priority/size/age orthogonal lets them filter and advise, and lets derived predicates cross-check stated importance against actual position (`buried`) — which is only possible if priority stays a distinct stored fact rather than collapsing into rank. Consistent with the spine: store work-state _facts_ and _general-purpose signals_; derive the rest ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)).
- **Relative + core-owned numbers** keep the caller out of the bookkeeping: the consumer states intent ("x before y"), never an absolute integer it would have to manage or keep collision-free. This is what makes the storage mechanism a free, reversible internal choice.
- **The rankable-set restriction is what makes it cheap.** Bounding rank to non-terminal, non-held tasks in a single project keeps the ordered list small, so even naive contiguous reindex is trivial — dissolving the integer-gaps-vs-fractional-vs-reindex question that originally motivated this decision.

## Considered and rejected

- **Priority partitions the sort (kanban: priority = columns, rank = order within column)** — the initial frame. Rejected: it makes "deliberately rank a P2 over a P0" impossible, which is the main job manual ordering exists to do; and you'd never visualize priority as columns anyway.
- **Pure derived order (priority + deps + age, no stored manual rank)** — rejected: removes the human's hand from the tiller entirely; there's no way to say "do this specific one next" against the heuristic.
- **Sparse rank with a fallback sort (only some tasks ranked, rest by priority/seq)** — rejected: forces a "where does the explicit one sit among the unranked pile?" interleave question that reintroduces priority as a tiebreaker — the partition this decision removes. Dense over the rankable set avoids it.
- **Caller-supplied absolute rank numbers** — rejected: makes the consumer own a contiguous/collision-free integer space; relative intent + core-owned numbers is strictly less burden.
- **Pinning the storage mechanism now** — rejected as premature: the small, project-scoped rankable set makes the choice immaterial and freely reversible; pinning it would record a non-decision as if it were load-bearing.
- **Restoring prior rank on re-entry (unpark/unblock)** — rejected for now: requires remembered-position state; append-to-bottom is simpler and a re-entering task is a natural re-triage point.

## Consequences

- The task spine's ordering field is named **`rank`** (not `order` — SQL-reserved, overloaded); it is nullable and present only for the rankable set.
- `next_tasks` sorts by `rank` over the `ready` subset; `priority`/`size` become _filter_ parameters and ranking _signals_, not sort keys.
- Lifecycle/hold verbs ([ADR 0001](0001-task-status-two-axes-derived-rollup.md)) gain a rank side effect: `complete`/`abandon`/`park`/`block` clear rank; `create`/`unpark`/`unblock` append to bottom. One transaction, alongside the transition-log row ([ADR 0003](0003-append-only-transition-log.md)).
- A relative reorder verb (e.g. `reorder_task(id, before|after|top|bottom, ref?)`) on the core; the HTTP envelope may expose a combined move (priority + position) as a convenience, the MCP envelope keeps them separate.
- Reindex, if ever needed, is bounded to one project's actionable tasks — never global.
- **Deferred:** the `buried`/archaeology predicate family (post-v1); whether agents keep their _own_ ordering overlay (possibly a tag-scoped list — too unformed to design now).
