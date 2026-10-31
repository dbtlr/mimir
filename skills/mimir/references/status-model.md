# The status model

## Two stored axes — tasks only

A **task** stores exactly two orthogonal status axes; nothing else stores status at all
(the grooming state below is a separate stored judgment, not a status axis):

- **lifecycle** — pure progress, moved by verbs: `todo → queued → in_progress → done`, plus
  `abandoned`. (`done`/`abandoned` are **terminal**.) An **optional** `under_review`
  gate sits between `in_progress` and `done` (see below).
- **hold** — why it is set aside: `none | blocked | parked`, each with a reason.
  `blocked` = involuntary/external; `parked` = deliberate deferral. A hold coexists
  with `in_progress` — releasing it resumes in place.
- **block owner** — who can clear a `blocked` hold: `you` (the operator must answer or
  act) or `others` (someone outside the board must). It is set only while the hold is
  `blocked` and empty otherwise; `parked` has none. See "Who can clear a block" below.

There is no editable status field. Verbs: `queue` `unqueue` `start` `submit` `return` `done` `abandon`
`reopen` · `block`/`unblock` · `park`/`unpark`. Every transition is logged (same
transaction) with its reason — `get <id> --col history` shows the trail.

### The `queued` reservation

A run reserves work with `queue <id> --harness <harness> --session <run-session>`:
`todo → queued`. A nonblank session is required. The reservation is
compare-and-swap guarded, so competing orchestrators cannot both take it.
Queued work is nonterminal and leaves `ready`, `next`, and overview's next list;
it appears in `list --status queued`.

- `start <id>` accepts `todo` or `queued` and moves to `in_progress` while
  preserving an established main identity. The main agent supplies its main
  flags; a distinct whole-task owner supplies `--worker-session` and optionally
  `--worker-harness` when known. Helper agents leave task identity alone.
  Starting queued work preserves a worker preassigned with `update`, resets
  only host and branch, and applies supplied values. History retains both main
  and worker identities.
- `unqueue <id> "reason"` moves `queued → todo`, clears all handles, and echoes
  the released run handles in history. A nonblank cancellation reason is required.
  The task reads `ready` again if its dependencies are settled, or `awaiting`
  otherwise.
- `done` and `abandon` accept queued tasks. `park` and `block` require `unqueue`
  first, so a queued task always represents a run's reservation.
- Queued work stays rankable alongside unheld `todo` and `in_progress` work.
  Queueing and unqueueing preserve its rank, so cancellation restores its
  previous place in `next` when ready. Stale reservations surface in hygiene.

### Who can clear a block

`block` records an owner beside the reason:

```sh
mimir block KEY-9 --on you "need a decision on the retry policy"   # the operator must act
mimir block KEY-9 --on others "waiting on the vendor's fix"        # someone outside the board
mimir block KEY-9 "waiting on the vendor's fix"                    # no --on: the default
```

- **The default follows `upstream`.** Without `--on`, a task whose `upstream` seed
  is set blocks as `others` (the reference names the board it asked for help), and
  any other task blocks as `you`. The default is evaluated when you block, so set
  `--upstream` before `block`.
- **Another task is never an owner.** Waiting on a dependency is the derived
  `awaiting` status; the owner only splits the manually-set block.
- **Changing an owner is `unblock`, then `block`.** `block` still refuses a task
  that is already held, and `unblock` clears the owner. `get` shows a `block owner`
  line while a task is blocked; `--eq block_owner:you` filters.
- **Hygiene is unchanged.** `stale` chases blocks of either owner: an old `others`
  block is the nudge to chase the other party. In the console, only blocks owned by
  `you` count as needing the operator; `under_review` tasks and unheld
  `needs_answers` tasks count too.
- `--on` belongs to `block` (and `depend`/`undepend` and the date filters); other
  verbs refuse it.

### The `under_review` gate (optional)

`under_review` holds work that is ready for a review gate, such as a human review
or a merge, before it counts as done:

- `submit <id>` — `in_progress → under_review`: the work is ready for its review
  gate. Handles stay on the task, and fixes made in response to the review need no
  status change.
- `done <id>` — the gate cleared (`under_review → done`).
- `return <id> "what to change"` — the review sent the work back
  (`under_review → in_progress`).

It is **optional** — `in_progress → done` directly is legal when no gate applies. An
`under_review` task leaves the rankable set, so `next` won't surface it — but `stale`
_will_ chase it if the review sits too long. The console lists every `under_review`
task as a verdict the operator owes.

### Reopening a terminal task

`done`/`abandoned` are terminal but not immutable: `reopen <id> "reason"` moves
either back to `in_progress`, clearing `completed_at` and re-entering the rankable
set at the bottom — a fresh re-triage point, not a resume-in-place. The original
terminal transition stays in the log; reopening is append-only, not a rewrite. It's
the deliberate correction path for a call that was wrong (a premature `done`, a
wrongly-abandoned approach) — never for new scope on genuinely finished work, which
is a new task.

### Grooming state — a third, separate judgment

A task also stores a **grooming state**: `not_groomed` (the default),
`needs_answers`, or `groomed`. It answers "is this task understood well enough
to run?", where `ready` answers "is anything stopping it right now?". The two
are independent: a `ready` task can be `not_groomed`, and a `groomed` task can
be `awaiting` a dependency. `groom <id> <state> [note]` sets it
(`references/authoring.md`); nothing infers it, and `start` never checks it.
Views read it for `todo` tasks only. Containers store none.

It is also separate from the seeds grooming queue (`references/seeds.md`), which
triages requests that are not yet tasks. A seed promoted into a task produces a
`not_groomed` task.

## The status word — derived, never stored

What `list`/`get` show as `status` is computed:

- **Task:** highest match wins:
  `abandoned → done → blocked → parked → in_progress → under_review → queued → awaiting → ready`.
  - `ready` = todo, un-held, every dependency settled — actionable now.
  - `awaiting` = todo, un-held, ≥1 unsettled dependency — self-clears, don't chase.
  - `queued` = reserved by a run, before a worker begins.
  - A dependency is **settled when its prerequisite is terminal** (`done` _or_
    `abandoned`) — abandoning a prereq never strands dependents.
  - **Started-but-held shows the hold word**, not `in_progress` — "set aside" is
    the honest glance-fact; the position underneath is preserved.
- **Container (phase/initiative/project):** no stored status — its truth is the
  **distribution** of its children's words (`mimir status KEY-3`), reduced to one
  word by a fixed precedence: _no children_ → `new` · any `in_progress` → that ·
  any `under_review` → that · any `queued` → that · any `awaiting` · any `ready` · any `blocked` ·
  any `parked` · any `new` · all terminal → `done` (or `abandoned` if nothing was
  done). Progress and reservations lead the middle order:
  under_review beats queued beats awaiting beats ready beats blocked beats parked. Rollup recurses —
  a phase tallies tasks, an initiative tallies phases.

## Status groups (selection universes for `--status`)

- `live` — every non-terminal word (`list`'s default).
- `terminal` — `done` + `abandoned`.
- `all` — everything.
- Or any single word: `--status blocked`, `--status awaiting`, …

## Verdicts (`--is` / `--not-is`) — judgments, not statuses

- `stale` — `ready`/`queued`/`in_progress`/`under_review` but untouched past the threshold
  (14 days). Chases `blocked` and `under_review` (a review the human never got to)
  too; queued reservations from a crashed run are chased by the same rule.
  **Mutes `parked`** (deliberately shelved — don't nag).
- `blocking` — has live dependents; finishing it unlocks work.
- `orphaned` — live task whose every sibling is terminal — left behind.

## Containers aren't lifecycle-managed

Lifecycle verbs (`queue`, `unqueue`, `start`, `submit`, `return`, `done`, `abandon`, `reopen`,
`park`/`unpark`, `block`/`unblock`) only act on **tasks**. Trying to `start` a phase or initiative is an error — the response
names a ready child task to start instead. Complete the leaf tasks and the
container's rollup follows automatically; there is nothing to do at the
container level.

## Working with the model

- The backlog is `todo` minus holds, ordered by rank; there is no separate
  backlog state.
- `depend` records an edge, and the derived `awaiting` handles edge-waiting.
  `block` is a manual hold for an external obstruction.
- An empty container reads `new`, because nothing under it was ever done.
- Read statuses from Mimir when you need them. They are derived live, so a
  copied status drifts.
