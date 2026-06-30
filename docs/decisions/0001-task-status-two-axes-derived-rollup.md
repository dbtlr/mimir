---
title: 'ADR 0001: Task status — two axes, derived readiness, distribution rollup'
status: accepted
date: 2026-06-03
---

# ADR 0001: Task status — two axes, derived readiness, distribution rollup

A task's status is modeled as **two orthogonal stored axes** plus **derived predicates**, not one enum:

- **Lifecycle** (stored, mutually exclusive, verb-driven): `todo → in_progress → done`, plus `abandoned`. Pure progress — how far along the task is.
- **Hold** (stored overlay): `none | blocked | parked`, each non-`none` value carrying a reason. _Why_ the task is set aside — `blocked` = involuntary/external obstruction, `parked` = voluntary/deliberate deferral. Orthogonal to lifecycle, so a started task can be held without losing its in-progress position.
- **Readiness is derived, never stored**: `ready = lifecycle == todo AND hold == none AND all deps settled`; `awaiting = lifecycle == todo AND hold == none AND ≥1 dep unsettled`. `awaiting` is the derived, involuntary sibling of `blocked`. A dependency is **settled** when its prerequisite is **terminal** — `done` _or_ `abandoned` — not strictly `done` (refined 2026-06-05 at build; see below).

**Non-leaf nodes (phase, initiative) store no status.** Their truth is the **derived distribution** over children (e.g. `{done:3, ready:1, blocked:1}`). The core exposes exactly one canonical pure function `interpret(distribution) → label` for when a single word is needed; the distribution always travels alongside it (the label is the _what_, the distribution the _why_). Rollup recurses over **direct children**, so phase/increment boundaries survive. **No `status_override`.**

## Why

- **The spine is "derive, don't store" — a cached/forced rollup is itself a sync surface.** `status_override` was a manually-stored status on a derived node: the exact thing the system exists to kill, and silently wrong the moment children move. Removed.
- **Lifecycle and obstruction answer different questions.** "How far along?" vs. "is there an obstruction?" The spec's single enum conflated them, which is why its `blocked` meant both "marked blocked" and "has incomplete deps" at once. Splitting the axes de-overloads it.
- **`blocked` and `parked` are reversible suspensions with a reason, so they belong on an overlay, not the lifecycle.** Both can coexist with `in_progress` (start a task, then hit a wall / defer it), and on release should return to the underlying lifecycle position rather than reset to `todo`. The discriminator used throughout: _coexists with `in_progress` → overlay; doesn't → lifecycle value._
- **`parked` is kept distinct from `blocked` (not collapsed to a generic "held") so hygiene can treat them oppositely:** `stale` **mutes** `parked` (deliberately set aside — don't nag) but **chases** `blocked` (untouched-for-weeks is exactly the nudge `stale` exists for). Collapsing them forfeits the original hygiene-decay fix.
- **Distribution-as-truth keeps the rollup lossless**, and one canonical `interpret` gives every consumer (agent, UI, context-loader) the _same_ single word so they don't drift — convention decay relocated to the readers is still convention decay. Recursing over direct children (a phase tallies task-states, an initiative tallies phase-labels) preserves the "uniquely testable increment" boundary a flat leaf-percentage would erase.

## Considered and rejected

- **`status_override` on derived nodes** — stored status on a derived node; reintroduces the sync surface, lies silently when children change. Every case it would handle is expressible through child state.
- **A single collapsed status enum with a fixed rollup ordering** (spec §5.2) — bakes one consumer's interpretation into the substrate and forces lossy collapse; replaced by distribution-as-truth + optional `interpret`.
- **One flat enum mixing lifecycle and obstruction** (spec's `backlog → ready → in_progress → blocked → done`) — overloads `blocked`, and makes `(in_progress, blocked/parked)` unrepresentable, forcing a lossy reset on suspend.
- **`parked` as a lifecycle value / `backlog` as a stored state** — fails the coexist-with-in_progress test; `backlog` is also an overloaded term (the whole not-done pile). Adopted `parked` (a term already established in working practice) as a hold value instead.
- **Letting each consumer interpret the distribution freely ("reason as they will")** — relocates convention decay to the readers; one canonical `interpret` in the core prevents drift.

## Consequences

- **Glossary updated** in the same pass (Status, Rollup rule, Phase, Initiative, Task, Derived predicate, Lifecycle verb, `stale`; new `parked` / two-axes entries).
- **Mutation surface:** add `park_task(id, reason?)` / `unpark`; `block_task`/`unblock` set/clear the `hold` overlay. `status` stays out of the `update` patch set (already spec §6.1). **Revised by [ADR 0003](0003-append-only-transition-log.md):** abandon/park/block reasons ride the transition-log row, not an annotation.
- **`stale` must exclude `parked`** from its candidate set.
- **`status_of` returns distribution + canonical label together;** the rollup function recurses over direct children via `interpret`.
- **Open / deferred:** the `hold` field name (`hold` is provisional); display precedence among `parked`/`blocked`/`awaiting` for a task that is both held and deps-pending (a derived-layer concern, not a stored rule); whether to also expose a flattened leaf-`%` rollup alongside the direct-children one.

## Refinement — dependency satisfaction is _terminal_, not _done_ (2026-06-05, at build)

The original "all deps **done**" wording would leave a task **`awaiting` forever** if a prerequisite were `abandoned` — the prereq will never become `done`, so the dependent could never clear without a manual `undepend`. That contradicts the rollup principle that **`abandoned` is terminal-but-not-blocking** ("an abandoned child never freezes its parent", ADR 0008 / glossary **Rollup**): a decided-not-to-happen prerequisite is _resolved_, not pending. So a dependency is **satisfied when its prerequisite is terminal** (`done` ∨ `abandoned`), and "incomplete dependency" means **non-terminal**. (For a non-leaf prerequisite, terminal = its rollup is `done`/`abandoned`.) Confirmed reasonable and adopted; `ready`/`awaiting` above read accordingly. Implemented as the single `isNodeSettled` helper in the core (`derive.ts`), so the rule has exactly one home. The sibling `blocking` predicate uses the same notion in reverse: a node is `blocking` only while ≥1 **non-terminal** dependent still needs it.

## Refinement — the optional `under_review` lifecycle gate (2026-06-22, MMR-84)

A fourth lifecycle value, **`under_review`**, is added as an **optional** ship-readiness gate between `in_progress` and `done`: `todo → in_progress → under_review → done`, with `in_progress → done` still legal (the gate is opt-in per task). The doer asserts the work is shippable and submits it; a reviewer either approves (`under_review → done`) or requests changes (`under_review → in_progress`).

**It is a lifecycle value, not a hold.** It fails the hold discriminator twice over: it does not coexist with `in_progress` (they are mutually-exclusive progress positions), and it _advances_ to `done` / _demotes_ to `in_progress` rather than releasing back to the prior position the way a hold does. The "waiting on the reviewer" is intrinsic to the position — folding it into `awaiting` (dependency-gated) or `blocked` (external obstruction) would conflate three different waits.

Consequences, each following from "non-terminal but not agent-actionable":

- **Verbs:** `submit_task` (in→review) and `return_task(reason?)` (review→in, the reason carrying the requested changes). Approval reuses `complete_task` — the transition-log `from=under_review` distinguishes an approved completion from a direct one, so no separate "approve" verb. Holds stay orthogonal: a review can be `block`/`park`-ed.
- **Rank:** `under_review` is **not** in the rankable set (the agent can't act on it), so `submit` clears `rank` and `return` re-appends at the bottom — exactly the hold enter/release pattern. A held review released back to `under_review` stays non-rankable (`isRankable` is the single source of this truth).
- **Status word + rollup:** `under_review` joins the closed vocabulary, ranked **just under `in_progress`** in both the task projection and the `interpret` cascade (both are live-progress; it is _past_ `in_progress`) — above the not-yet-started and stuck/shelved words. See [ADR 0008](0008-state-word-projection-and-interpret-cascade.md).
- **Hygiene:** `stale` **chases** `under_review` (a submission the human never got to is the rot the nudge exists to surface). The `Attention` set (`blocked` + `stale`) is unchanged — a fresh review is healthy, not stuck.
- **Storage:** lifecycle is row-local CHECK-enforced, so admitting the value is a `node` table rebuild (migration 0006), done with `foreign_keys` off (the SQLite adapter is non-transactional-DDL) so no child table is disturbed.

## Refinement — terminal states are reversible via `reopen` (2026-06-27, MMR-104)

`done` and `abandoned` are terminal but not irreversible. A single `reopen`
verb moves either back to `in_progress`, re-entering the rankable set at the
bottom (a reopen is a re-triage point) and clearing `completed_at`; an optional
reason rides the transition-log row. The reversal is **recorded, not erased** —
the original terminal transition is kept (append-only, ADR 0003), so the full
trail (`… → done → in_progress → …`) survives.

`reopen` is the deliberate _correction_ path (e.g. a `done` declared before
verification). It does not weaken `done` as a trust signal: preventing
premature completion is the optional `under_review` gate (`submit`/`return`),
not a casual toggle. Reopen lands in `in_progress`, not `under_review`, so the
doer re-runs the normal gate flow rather than routing around it. No new
lifecycle value and no migration — the verb only adds a legal transition edge.

## Refinement — dependencies are inherited down the tree (2026-06-30, MMR-115)

A dependency declared on a **container** (phase/initiative/project) gates every
task in its subtree, not only the node carrying the edge. A task's **effective
prerequisites** are its own dependency edges _unioned with every ancestor's_, so
"Phase 2 depends on Phase 1" makes every task under Phase 2 read `awaiting`
(dropping out of `ready`/`next`) until Phase 1 settles. The previous behavior —
where a container-level edge only surfaced on the prerequisite's `blocking`
verdict and gated nothing on the dependent side — made `depend` silently inert
when pointed at a container, contradicting the model's treatment of
initiative→initiative prerequisites as real work constraints.

- **Effective, not direct.** `hasUnsettledPrereq` gathers the edges over the
  node's whole lineage (`lineageIds` walks `parent_id` to the root). Declaration
  level no longer changes whether the gate bites. Settledness is unchanged
  (`isNodeSettled`): a container prerequisite is satisfied when its rollup is
  terminal, so descendants clear exactly when the prerequisite rolls up
  `done`/`abandoned`. Transitivity flows through settledness — no extra
  recursion over an ancestor's own prerequisites is needed.
- **Leaf-cascade.** The change lives only at the leaf: containers keep deriving
  status from their children, so a phase reads `awaiting` because its tasks now
  do (the `interpret` "any `awaiting`" path), while a phase with a
  manually-started task reads `in_progress` (live work wins — honest). An empty
  container with its own prerequisite stays `new` (nothing to gate yet; the gate
  activates when a task is added).
- **Advisory + todo-only.** The gate governs _picking up_ work: a descendant
  todo reads `awaiting` instead of `ready`, but `start` is not blocked (edges
  were never enforced on `start`) and an already-`in_progress` descendant is not
  retroactively un-started.
- **Lineage guard.** `depend` rejects an edge whose endpoints are in an
  ancestor/descendant relationship (either direction) — inheritance would make a
  descendant await its own ancestor, or a container await a task it contains, a
  deadlock the raw-cycle (`reaches`) check structurally cannot see. `move`
  enforces the same invariant from the other side: a re-parent is rejected if it
  would put any node in the moved subtree on either side of one of its
  dependency edges (otherwise a legal cross-lineage edge could be turned into a
  same-lineage one, hanging status evaluation). Cross-lineage edges (sibling
  phases, task→task across branches) are unaffected.
- **Surfacing.** The `deps` facet gains `awaitingOn` (wire `awaiting_on`): the
  still-unsettled effective prerequisites, each tagged with the ancestor it is
  inherited `via` (absent for a node's own edge). `dependsOn` still lists only
  the declared direct edges (a stored fact). The CLI record and the console
  drawer render an "awaiting on … (via …)" line; structured formats carry the
  fields, no prose (self-orienting split).
