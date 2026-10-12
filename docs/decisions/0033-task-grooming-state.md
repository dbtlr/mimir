---
title: 'ADR 0033: Tasks carry a stored grooming state'
description: A task records whether it is understood well enough to run — not groomed, needs answers, or groomed — as an explicit judgment set by one verb, never inferred and never a gate on start.
status: accepted
date: 2026-10-12
---

# ADR 0033: Tasks carry a stored grooming state

The console rebuild (MMR-356) gives a project a work page whose Frontier
separates work an agent can pick up from work that still needs planning. Mimir
can already say whether a task is free to run (ADR 0001 readiness: todo, no
hold, dependencies settled). It cannot say whether anyone has judged the task
well enough specified to run. That judgment lives in someone's head or in the
description's prose, so neither the operator nor an agent can ask the board for
it.

## The decision

1. **Grooming state is a stored, task-only field** with three values:
   `not_groomed` (the default), `needs_answers`, and `groomed`. It answers "is
   this task understood well enough to run?", which is a different question
   from readiness's "is anything stopping it from running now?". A ready task
   can be ungroomed, and a groomed task can be awaiting a dependency.
2. **It is a judgment, never inferred.** No rule reads the description, its
   length, or its annotations to set or suggest the value. Only an explicit
   act changes it.
3. **One verb sets it.** `mimir groom <id...> <state> [note]` sets the state on
   one or more tasks in a single transaction. The note is required for
   `needs_answers` and optional otherwise. It is written as an ordinary
   annotation in the same transaction, so a task's open questions live in its
   notes beside every other note. `create --groomed` covers tasks carved from a
   finished design, which are groomed at birth. `update` never touches the
   field.
4. **Editing a description never resets it.** Whoever edits a groomed task
   decides whether the edit changed its readiness, and re-grooms if so.
5. **It is a pre-start judgment, not a gate.** The state can be set at any
   lifecycle, but views read it only for `todo` tasks. `start` never checks
   it. A started task that hits an open question is blocked with the operator
   as owner (`block --on you`, ADR 0001 block ownership refinement), not moved
   back to `needs_answers`.
6. **Containers store no grooming state.** A container's planning need comes
   from its structure: an initiative or phase with no open children reads as
   _to break down_. This follows ADR 0001's rule that non-leaf nodes store no
   status.
7. **`next` keeps its membership and order.** Rank stays the primary order
   (ADR 0007). `next` rows show each task's grooming state, and
   `--eq grooming:groomed` narrows the queue. The agent skill teaches agents to
   prefer groomed work, as a convention rather than a filter built into the
   queue.
8. **Grooming changes write no transition-log row.** The state is a stored
   judgment like `priority` or `size`, which are not logged either. The
   reasoning behind a change is in the annotation the verb writes.
9. **No backfill.** Existing tasks start `not_groomed`. Exports written before
   the field existed import as `not_groomed`.

## Why

- **Readiness is the wrong home.** ADR 0001 keeps readiness derived from
  lifecycle, holds, and dependencies so that it can never drift. A judgment
  about specification cannot be derived from those facts, and folding it into
  `ready` would make the derived word depend on a stored opinion.
- **An explicit verb makes the judgment accountable.** A value set by a named
  act, with its open questions written beside it, can be trusted by a view or
  an agent. A value inferred from the description's shape would mark a long,
  vague description as groomed and a terse, precise one as not.
- **Never gating `start` keeps the field cheap.** If grooming blocked work, an
  operator in a hurry would mark everything groomed to get past the gate, and
  the field would stop meaning anything.
- **Questions belong in notes.** A dedicated questions field would split a
  task's history in two. An annotation written by the verb keeps one timeline,
  and the existing note surfaces show it with no new UI.

## Considered and rejected

- **A `groomed` tag.** Tags are the grouping axis (ADR 0005), and ADR 0002
  keeps consumer semantics out of the schema. But grooming is a closed,
  single-valued vocabulary that Mimir's own views read, the same shape ADR
  0020 gave a seed's `kind`. Tags are open and multi-valued, so a task could
  carry both `groomed` and `needs-answers`, and nothing could require a note
  for the second.
- **A `backlog` lifecycle value before `todo`.** ADR 0001 already rejected a
  single enum that mixes progress with other questions. A lifecycle value
  would also gate `start` and drop the task from rank, both of which this
  record rejects.
- **A hold value.** Holds are obstructions with a reason, and a held task
  leaves the rank. An ungroomed task is not obstructed, and keeping it in
  `next` is deliberate.
- **Logging changes in the transition log.** The log's closed kind vocabulary
  (lifecycle, hold, dependency, move, archive) records status and structure.
  Adding a kind for a judgment field would also mean rebuilding a SQLite table
  to widen its check constraint, for history that the annotations already
  carry.
- **Resetting to `not_groomed` when the description changes.** Most edits are
  clarifications that a groomed task should survive. An automatic reset would
  make `groomed` decay on every typo fix.

## Consequences

- The `grooming` column lands in schema migration `0002` for both SQL dialects
  (ADR 0032), with conformance coverage. The transfer document gains the key
  with a `not_groomed` default.
- `groom` is a new flat work verb (ADR 0024) in the CLI, MCP, and HTTP. It is
  separate from the agent skill's _groom-next_ finishing step, which rewrites a
  container's `## Next` direction. The skill words the two so they are not
  confused.
- **Grooming state** and **grooming queue** are different things. The grooming
  queue (ADR 0020) holds seeds: requests that may or may not become work. A
  seed promoted into a task produces a `not_groomed` task.
- The work page's Frontier (MMR-439) and the review page (MMR-440) read this
  field. The console shows it as a chip and can set it from the task page.
