---
title: 'ADR 0003: Append-only transition log'
status: accepted
date: 2026-06-03
---

# ADR 0003: Append-only transition log

Every status-bearing mutation appends a row to an **append-only transition log**, _alongside_ (not instead of) the current-state columns:

- **Columns answer "what is it now"** — the fast path, source of truth for current state.
- **The log answers "when/how did it change"** — `(task/node id, kind, from, to, at, reason?)`, append-only.
- The **lifecycle / hold / dependency / `move_node` verbs** are the single choke point that writes column + log row in one transaction, so the two can't drift. The log is never the read path for current state, so it is **not** a derived-state cache / sync surface.
- **Transition reasons ride the log row** (`abandon`, `park`, `block`), not an annotation.
- **Derived flip-times are computed from the log, never stored.** `became_ready_at = MAX(task's last readiness-relevant transition in the log, latest dependency's completed_at)`, guarded by currently-ready. So `newly_ready since X` is derivable without storing the derived `ready` state — derive-don't-store extends all the way down to _transition times_.

Scope: verb-driven transitions (lifecycle, hold, dependency edges, `move_node`). Scalar `update` edits (title/priority/rank) just bump `updated_at` and are **not** logged — widen later if change-history of those turns out to be a worthwhile insight.

## Why

- The spec deferred a watermark for "since" predicates. The cleaner resolution: a derived predicate's _flip time_ is itself a function of its inputs' **stored** transition times, so the transitions are timestamped rather than the derived state stored.
- **Append-only matches the existing history rule** (design spec Appendix A.4), and the verb surface gives a natural, drift-proof write choke point.
- Committing to the full log now (vs. minimal per-transition columns) is cheap and **compounds**: it sets up audit and future "since"/insight queries for free, and preserves full flip history rather than just the latest flip.

## Considered and rejected

- **Minimal per-transition timestamp columns only** — gives the _latest_ flip but no history; sufficient for `newly_ready` alone, but the log was chosen for the compounding optionality (an explicit call: "small to add, sets us up for other insights").
- **Event-sourcing — current state as a fold of the log** — would make every read fold the log, or require a cached projection, which is itself a sync surface. Columns stay authoritative for "now"; the log is additive history.
- **Storing `became_ready_at` / any derived flip-time** — re-introduces stored derived state (the thing [ADR 0001](0001-task-status-two-axes-derived-rollup.md) removed); derive it instead.

## Consequences

- New append-only transition-log table keyed to the node, capturing `kind, from, to, at, reason?`.
- **Revises [ADR 0001](0001-task-status-two-axes-derived-rollup.md):** abandon/park/block _reasons_ now live on the transition row, **not** an annotation. `annotation` reverts to its clean job — freeform in-flight notes only.
- `became_ready_at` and any future "became X" timestamp are pure derivations over the log + dependency completion.
- Scalar field edits remain outside the log.
