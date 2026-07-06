---
title: 'ADR 0008: State word projection and the interpret() rollup cascade'
status: accepted
date: 2026-06-04
---

# ADR 0008: State word projection and the interpret() rollup cascade

[ADR 0001](0001-task-status-two-axes-derived-rollup.md) split status into two stored axes and declared that non-leaf nodes carry no status — their truth is a derived **distribution** over children plus "exactly one canonical pure function `interpret(distribution) → label`." It deliberately left that function undefined. This ADR defines it, and the per-task projection it depends on.

The two are one mechanism: every node — leaf or not — reduces to a single canonical **state word**, drawn from one **closed** vocabulary, so rollup recurses cleanly (a phase tallies task state words; an initiative tallies phase state words).

## The task projection (leaf → word)

A task carries `lifecycle ∈ {todo, in_progress, done, abandoned}`, a `hold ∈ {none, blocked, parked}` overlay, and derived readiness. Its state word is a precedence projection, **highest wins**:

```
abandoned → done → blocked → parked → in_progress → awaiting → ready
```

Every cell is forced by the axes except one genuine judgment call: a **started-but-held** task (`in_progress` + `blocked`/`parked`). It resolves to the **hold word**, not `in_progress`. "Set aside / not moving" is the salient glance-fact; the `in_progress` position is preserved underneath (the task resumes in place on release, per ADR 0001) and stays visible in the full two-axis detail. The alternative — `in_progress` wins — would let a wedged task masquerade as live work in every list and rollup.

This word is the single canonical task `state` reported by `get_task` / `list_work`, **and** the unit the rollup distribution counts — one definition, three uses (see glossary **State word**).

## The interpret() cascade (non-leaf → word)

`interpret(distribution)` is a precedence cascade — first non-empty bucket wins:

```
1. no children        → new          # empty-guard: never vacuously `done`
2. any in_progress     → in_progress  # live work beats all
3. any ready           → ready        # actionable now
4. any awaiting         → awaiting     # actionable soon — deps self-clear
5. any blocked          → blocked      # externally stuck
6. any parked           → parked       # deliberately shelved
7. any new              → new          # only undefined sub-chunks remain
8. all terminal         → done if any done, else abandoned
```

Steps 1–3 and 8 are inherited from the design spec's §5.2 single-enum rule (active > ready > … > all-abandoned > done, empty-guard mandatory). The load-bearing new judgment is the **middle order `awaiting` > `blocked` > `parked`**, ordered by _distance to motion_: `awaiting` self-clears when its dependencies finish, `blocked` needs an external unblock, `parked` is a deliberate stop. So a node whose only live work is dependency-gated reads `awaiting` (hopeful), not `blocked`.

> **Refinement (2026-06-22, MMR-84):** the optional `under_review` lifecycle gate adds one word to both orderings. In the **task projection** it sits at `… → in_progress → under_review → awaiting → ready` (mutually exclusive with `in_progress`, so the exact adjacency is moot; both rank below the holds, so a held review reads as the hold word). In the **cascade** it is inserted as step 3, immediately after `in_progress` and before `ready` — both are live-progress and `under_review` is _past_ `in_progress`, so it outranks the not-yet-started and stuck/shelved words. See [ADR 0001](0001-task-status-two-axes-derived-rollup.md) § "the optional `under_review` lifecycle gate" for the full rationale.

## The vocabulary is closed (+ one non-leaf word)

`interpret` must return a word from the same set it consumes, because the parent's parent will tally _that_ word. The shared set is `{ready, awaiting, blocked, parked, in_progress, done, abandoned}`. A task can never project to **`new`**; it is a non-leaf-only word for an empty container (a phase with no tasks, an initiative with no phases). `new` is _not_ the lifecycle value `todo` — reusing `todo` here would overload the axis; `new` keeps them distinct.

## Why

- **One word, defined once.** The task's display `state`, the rollup bucket, and the recursion input are the same vocabulary — a rollup-only label set would be a second source of "what word describes this" and would drift.
- **Hold beats `in_progress` for honesty.** The single word exists for a glance; the most decision-relevant fact about a started-but-stuck task is that it is stuck, not that it was started. The lifecycle position is not lost — it lives in the stored axis.
- **Closed + recursive keeps rollup lossless and boundary-preserving** (ADR 0001's intent): a phase tallies task words, an initiative tallies phase words, so increment boundaries survive where a flat leaf-percentage would erase them.
- **Empty-guard is mandatory** — "all zero children terminal" is vacuously true; without the guard an empty phase reads `done`. `new` makes the empty state explicit and honest.

## Considered and rejected

- **`in_progress` wins over hold** in the projection — lets a wedged task read as live work in every rollup; rejected for the honesty reason above.
- **`blocked` > `awaiting`** in the middle (a lone blocked child dominates the glance) — defensible ("something's stuck, go look"), but loses the "distance to motion" read; a **cheap reversal** (flip cascade steps 4↔5) if the nudge value ever proves higher than the hope value.
- **A rollup-only label set** distinct from the task word — breaks closure and duplicates the "what word" definition.
- **`todo` as the empty-node word** — overloads the lifecycle value `todo`; replaced with `new`.
- **Caching the rolled-up label in a column** — the sync surface the whole system exists to remove (ADR 0001 spine).

## Consequences

- **Core exposes** `state(task)` (the projection) and `interpret(distribution)` (the cascade) as pure functions; `status_of(node)` returns **distribution + label together**.
- **`new` enters the external-facing vocabulary** — any consumer enumerating possible node states must include it (non-leaf only).
- **Glossary updated** in the same pass: new **State word** term; **Rollup** entry carries the full cascade and the `new` word.
- **Still deferred** (from ADR 0001, unblocked but not yet needed): display precedence among `parked`/`blocked`/`awaiting` when surfacing a single task that is both held and dep-pending; whether to also expose a flattened leaf-`%` rollup alongside the direct-children one.

## Refinement (2026-06-10 — external term renamed `status`)

The projection and cascade are unchanged; the _external word_ for the single derived label is now **status** — DTO field `status` (was `state`), CLI selection flag `--status`, glossary entry **Status**. Rationale: it is the lingua franca of every task tool (Jira/Linear/Asana/GitHub), and a `--status` flag filtering a field called `state` would be a two-dialect surface. "State word" wording in this ADR's body predates the rename; read it as _status word_. Selection of the verdict-style derived predicates (`stale`, `blocking`, `orphaned`) is a separate surface (`--is`) and not this ADR's concern. Groomed during the 2026-06-10 dogfood session; implementation `MMR-37`/`MMR-33`.

## Refinement (2026-07-06 — open-ended containers, MMR-204)

`interpret` and `taskStatus` are unchanged. A stored container flag `open_ended`
(phase/initiative; ADR 0001 Refinement) adjusts the derivation at the `derive.ts`
call sites, not the pure cascade:

- **Own word.** An open-ended container's _raw_ `interpret` word is coerced when
  it is **idle** — an all-terminal rollup (`done`/`abandoned`) or empty (`new`) —
  to `ready` ("open for filing"). It never reads `done`/`abandoned` (a standing
  home is never "finished") nor `new` (which would claim nothing was ever done).
  With live children the raw word passes through unchanged.
- **Parent transparency.** An idle open-ended container is a _transparent_ node:
  it is excluded from its parent's `childDistribution`/`rootDistribution`
  entirely, so a standing phase never strands a normal ancestor from
  auto-closing. Transparency is decided on the raw (pre-coercion) word, memoized
  per snapshot so the child walk isn't paid twice. With live children it tallies
  its word normally.

The `orphaned` verdict is muted for a task whose parent is open-ended (ADR 0001
Refinement); `stale`/`blocking` are unchanged.
