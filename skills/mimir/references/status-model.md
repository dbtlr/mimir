# The status model

## Two stored axes — tasks only

A **task** stores exactly two orthogonal things; nothing else stores status at all:

- **lifecycle** — pure progress, moved by verbs: `todo → in_progress → done`, plus
  `abandoned`. (`done`/`abandoned` are **terminal**.) An **optional** `under_review`
  gate sits between `in_progress` and `done` (see below).
- **hold** — why it is set aside: `none | blocked | parked`, each with a reason.
  `blocked` = involuntary/external; `parked` = deliberate deferral. A hold coexists
  with `in_progress` — releasing it resumes in place.

There is no editable status field. Verbs: `start` `submit` `return` `done` `abandon`
`reopen` · `block`/`unblock` · `park`/`unpark`. Every transition is logged (same
transaction) with its reason — `get <id> --col history` shows the trail.

### The `under_review` gate (optional)

When work is finished and shippable but wants a **human review** before it counts as
done, `submit` it instead of going straight to `done`:

- `submit <id>` — `in_progress → under_review`: "I believe this is shippable; it needs
  no more work." The ball is now in the reviewer's court.
- `done <id>` — the reviewer **approves** (`under_review → done`).
- `return <id> "what to change"` — the reviewer **requests changes**
  (`under_review → in_progress`); the doer picks it back up.

It is **optional** — `in_progress → done` directly is still legal when no review is
wanted. An `under_review` task is non-actionable (waiting on the human), so it leaves
the rankable set and `next` won't surface it — but `stale` _will_ chase it if the
review sits too long.

### Reopening a terminal task

`done`/`abandoned` are terminal but not immutable: `reopen <id> "reason"` moves
either back to `in_progress`, clearing `completed_at` and re-entering the rankable
set at the bottom — a fresh re-triage point, not a resume-in-place. The original
terminal transition stays in the log; reopening is append-only, not a rewrite. It's
the deliberate correction path for a call that was wrong (a premature `done`, a
wrongly-abandoned approach) — never for new scope on genuinely finished work, which
is a new task.

## The status word — derived, never stored

What `list`/`get` show as `status` is computed:

- **Task:** highest match wins:
  `abandoned → done → blocked → parked → in_progress → under_review → awaiting → ready`.
  - `ready` = todo, un-held, every dependency settled — actionable now.
  - `awaiting` = todo, un-held, ≥1 unsettled dependency — self-clears, don't chase.
  - A dependency is **settled when its prerequisite is terminal** (`done` _or_
    `abandoned`) — abandoning a prereq never strands dependents.
  - **Started-but-held shows the hold word**, not `in_progress` — "set aside" is
    the honest glance-fact; the position underneath is preserved.
- **Container (phase/initiative/project):** no stored status — its truth is the
  **distribution** of its children's words (`mimir status KEY-3`), reduced to one
  word by a fixed precedence: _no children_ → `new` · any `in_progress` → that ·
  any `under_review` → that · any `ready` → that · any `awaiting` · any `blocked` ·
  any `parked` · any `new` · all terminal → `done` (or `abandoned` if nothing was
  done). The middle order is "distance to motion": under_review (past in_progress)
  beats ready beats awaiting beats blocked beats parked. Rollup recurses —
  a phase tallies tasks, an initiative tallies phases.

## Status groups (selection universes for `--status`)

- `live` — every non-terminal word (`list`'s default).
- `terminal` — `done` + `abandoned`.
- `all` — everything.
- Or any single word: `--status blocked`, `--status awaiting`, …

## Verdicts (`--is` / `--not-is`) — judgments, not statuses

- `stale` — `ready`/`in_progress`/`under_review` but untouched past the threshold
  (14 days). Chases `blocked` and `under_review` (a review the human never got to)
  too; **mutes `parked`** (deliberately shelved — don't nag).
- `blocking` — has live dependents; finishing it unlocks work.
- `orphaned` — live task whose every sibling is terminal — left behind.

## Containers aren't lifecycle-managed

Lifecycle verbs (`start`, `submit`, `return`, `done`, `abandon`, `reopen`,
`park`/`unpark`, `block`/`unblock`) only act on **tasks**. Trying to `start` a phase or initiative is an error — the response
names a ready child task to start instead. Complete the leaf tasks and the
container's rollup follows automatically; there is nothing to do at the
container level.

## Don't fight the model

- Don't look for a "backlog" state — the backlog is `todo` minus holds, ordered by
  rank.
- Don't `block` to record an edge — `depend` records edges; `block` is a manual
  hold. The derived `awaiting` handles edge-waiting for you.
- Don't expect an empty container to read `done` — it reads `new` (nothing was
  ever done).
- Don't cache or copy statuses anywhere — they are derived live; copies drift.
