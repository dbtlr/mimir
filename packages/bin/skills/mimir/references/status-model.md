# The status model

## Two stored axes — tasks only

A **task** stores exactly two orthogonal things; nothing else stores status at all:

- **lifecycle** — pure progress, moved by verbs: `todo → in_progress → done`, plus
  `abandoned`. (`done`/`abandoned` are **terminal**.)
- **hold** — why it is set aside: `none | blocked | parked`, each with a reason.
  `blocked` = involuntary/external; `parked` = deliberate deferral. A hold coexists
  with `in_progress` — releasing it resumes in place.

There is no editable status field. Verbs: `start` `done` `abandon` ·
`block`/`unblock` · `park`/`unpark`. Every transition is logged (same transaction)
with its reason — `get <id> --col history` shows the trail.

## The status word — derived, never stored

What `list`/`get` show as `status` is computed:

- **Task:** highest match wins:
  `abandoned → done → blocked → parked → in_progress → awaiting → ready`.
  - `ready` = todo, un-held, every dependency settled — actionable now.
  - `awaiting` = todo, un-held, ≥1 unsettled dependency — self-clears, don't chase.
  - A dependency is **settled when its prerequisite is terminal** (`done` _or_
    `abandoned`) — abandoning a prereq never strands dependents.
  - **Started-but-held shows the hold word**, not `in_progress` — "set aside" is
    the honest glance-fact; the position underneath is preserved.
- **Container (phase/initiative/project):** no stored status — its truth is the
  **distribution** of its children's words (`mimir status KEY-3`), reduced to one
  word by a fixed precedence: _no children_ → `new` · any `in_progress` → that ·
  any `ready` → that · any `awaiting` · any `blocked` · any `parked` · any `new` ·
  all terminal → `done` (or `abandoned` if nothing was done). The middle order is
  "distance to motion": awaiting beats blocked beats parked. Rollup recurses —
  a phase tallies tasks, an initiative tallies phases.

## Status groups (selection universes for `--status`)

- `live` — every non-terminal word (`list`'s default).
- `terminal` — `done` + `abandoned`.
- `all` — everything.
- Or any single word: `--status blocked`, `--status awaiting`, …

## Verdicts (`--is` / `--not-is`) — judgments, not statuses

- `stale` — `ready`/`in_progress` but untouched past the threshold (14 days).
  Chases `blocked` too; **mutes `parked`** (deliberately shelved — don't nag).
- `blocking` — has live dependents; finishing it unlocks work.
- `orphaned` — live task whose every sibling is terminal — left behind.

## Don't fight the model

- Don't look for a "backlog" state — the backlog is `todo` minus holds, ordered by
  rank.
- Don't `block` to record an edge — `depend` records edges; `block` is a manual
  hold. The derived `awaiting` handles edge-waiting for you.
- Don't expect an empty container to read `done` — it reads `new` (nothing was
  ever done).
- Don't cache or copy statuses anywhere — they are derived live; copies drift.
