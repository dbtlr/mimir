---
title: "ADR 0001: Task status — two axes, derived readiness, distribution rollup"
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
