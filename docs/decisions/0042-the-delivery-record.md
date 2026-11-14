---
title: 'ADR 0042: The delivery — one attempt to deliver a phase through one branch'
status: accepted
date: 2026-11-14
---

# ADR 0042: The delivery — one attempt to deliver a phase through one branch

A **delivery** is one attempt to deliver a phase, or part of one, on one
integration branch through one milestone pull request. It is a project-anchored
record beside the work tree, shaped like a seed
([ADR 0020](0020-seeds-grooming-queue-entity.md)). It is not a node, and it
changes no node's derived status. Its tasks stay in their phase, and each one
holds a reference to its delivery.

## Decision

### The record

| Part      | Shape                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------- |
| Id        | `KEY-dN`, allocated per project like seeds (`project.last_delivery_seq`), never reused             |
| Phase     | The phase the delivery delivers, stored at create and fixed for the delivery's life                |
| Title     | Text, required                                                                                     |
| Lifecycle | `agreed → running → milestone → landed`, or `abandoned` from any non-terminal value               |
| Hold      | `none`, `stopped`, or `paused`, each held value with a reason                                      |
| Agreement | A body text, replaced whole on each write, like a container's `## Next` direction                  |
| Handles   | `branch` (integration branch), `external_ref` (milestone pull request), `harness`, `session`, `thread` (T3 thread) |
| Time cap  | A whole number of minutes, optional. Elapsed time is derived from the first `start` transition     |
| History   | An append-only log of lifecycle, hold, and membership changes ([ADR 0003](0003-append-only-transition-log.md)) |

- A delivery is born `agreed` with hold `none`. `landed` and `abandoned` are
  terminal. A terminal delivery has no hold, as a terminal task has none
  (ADR 0001, MMR-616 refinement), and refuses every write except reads.
- `stopped` means the agent cannot continue without the operator. It is always
  the operator's to clear, so a delivery stores no block owner. `paused` is the
  operator's deliberate pause.
- The handles are plain fields. Unlike a task's handles, no hold clears them:
  a stopped or paused delivery is still the same attempt on the same branch.
- Elapsed time and spend are not stored. Mimir stores the cap as an agreed term
  and derives elapsed time from the log; other spend stays in the session
  ([ADR 0026](0026-work-state-composition.md)).

### Verbs

The task verbs act on a delivery by id type, because their claim is the same.
`land` is the one new verb.

| Verb                | On a delivery                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `start`             | `agreed → running`. Refuses unless the delivery has at least one live member and a non-empty agreement |
| `block` / `unblock` | Sets and clears `stopped`, with the reason. For a budget stop, the reason states the spend      |
| `park` / `unpark`   | Sets and clears `paused`, with the reason                                                       |
| `submit`            | `running → milestone`: the milestone pull request is ready                                      |
| `return`            | `milestone → running`: the milestone review sent it back                                        |
| `land`              | `milestone → landed`, and every `staged` member moves to `done`, in one transaction. Refuses while any member is live and not `staged` |
| `abandon`           | Ends the delivery. In one transaction, every live member leaves it and returns to `todo` with its hold kept, each task logged with the reason |

`land` and `abandon` write many rows. Each is one store transaction, and each
checks the delivery's state inside that transaction, so a concurrent write
cannot leave a partial land or a partial release
([ADR 0023](0023-concurrency-and-safety-posture.md)).

### Membership

- A task has a nullable `delivery` field. It is its own field, not a resume
  handle: `park`, `block`, and `unqueue` clear handles (ADR 0026) and leave it.
- **A member** is a task whose `delivery` names a non-terminal delivery. A
  task is a member of at most one delivery at a time.
- Every member's parent is the delivery's phase.
- **Joining.** `create delivery --phase <phase>` takes every live task in the
  phase that is not queued and not already a member of another delivery.
  Naming `--task` ids takes only those tasks instead. Afterwards,
  `update <task> --delivery KEY-dN` adds a member and
  `update <task> --delivery none` removes one. Each change is logged on the
  task and on the delivery.
- **Who can join.** A task joins only while it is live (not `done` or
  `abandoned`) and not `queued`, only a non-terminal delivery, and only a
  delivery whose phase is the task's parent. A queued task refuses, because
  membership is itself the reservation and a queued task already holds one.
- **Move.** `move` of a member refuses and names
  `update <task> --delivery none`. Leaving a delivery is one deliberate,
  logged act. Moving the phase itself is unaffected, because the delivery
  stores the phase.
- **After the end.** `land` keeps each delivered task's reference, so a task
  records the delivery that landed it. `abandon` clears the reference of every
  released task. A task that names a terminal delivery is not a member: it may
  join a new delivery, and the new reference replaces the old one.

### Board rules

- The board-wide `next` leaves out every member. `next --delivery KEY-dN`
  lists that delivery's ready members.
- **The same-delivery dependency rule.** A prerequisite that is `under_review`
  or `staged` counts as settled for a dependent in the same delivery, and for
  no other dependent. Dependencies stay advisory
  ([ADR 0001](0001-task-status-two-axes-derived-rollup.md)): the rule changes
  whether the dependent reads `ready` or `awaiting`, and never gates `start`.
- `done` on a member refuses and names `land`, so a milestone merge stays one
  event. A staged member leaves the delivery through `land`, or returns to
  `in_progress` through `return`.

### Out of scope here

The decision record, the limitation and declined-finding lists, the run
journal, the since-cursor read, the T3 wake, and the delivery page are later
phases of the same design. Each records its own ADR or refinement.

## Why

- **A phase is the plan, and a delivery is an attempt.** A run has its own
  agreement, branch, pull request, budget, and outcome. On a phase, all of
  those would be fields that stay empty unless the phase is run, and a failed
  attempt would share its record with the plan. As its own record, a second
  attempt starts clean, and the abandoned one keeps its history.
- **Store beside, never over.** ADR 0001 rejected a stored status that replaces
  a rollup. A delivery stores its own state and leaves the phase's derived
  rollup unchanged, so no container rule changes. A phase still cannot close
  early, because `staged` is not terminal.
- **The dependency rule is exact.** "A prerequisite under review lets its
  dependent continue" holds only for tasks that share a branch, which means
  tasks in one delivery. Scoping the rule there keeps a dependent outside the
  delivery from reading `ready` on unmerged code.
- **One event is one transaction.** A milestone merge completes every member at
  once (`land`), and an abandoned attempt releases every member at once
  (`abandon`). Per-task writes would leave the board half-landed between calls.
- **Membership is the reservation.** The task's reference keeps other sessions
  off it, which is why `next` leaves members out. Using `queue` as well would
  store the same fact twice.
- **Join by phase, edit by task.** Delivering a whole phase is the common case,
  so create takes the phase's tasks by default. Removing a member must exist
  anyway (to ship a smaller milestone, remove the unfinished members, then
  `land`), and the same per-task edit adds one.
- **`start` requires a member and an agreement.** The lifecycle word `agreed`
  then means the terms exist, and a running delivery always has work to
  deliver. Branch, pull request, and cap stay optional, because the agent sets
  the branch after it begins.
- **The seed precedent is real.** The seed table is a project-anchored record
  outside `node` with its own lifecycle check and history. A delivery takes the
  same shape, and ids, allocation, history, and transfer follow the same paths.

## Considered and rejected

- **A second status axis on the phase.** It mixes plan and attempt, and a
  failed attempt leaves its fields on the plan.
- **A stored status that overrides the phase rollup.** ADR 0001's discriminator
  rejects it: a stored word that replaces a derived one is silently wrong when
  children move.
- **A delivery as a container in the tree.** Its tasks would have to move under
  it and leave their phase, and a partial delivery would split the phase on the
  board.
- **The name "run".** The glossary's agent run and the host's `runs` table
  already use it.
- **Membership as a resume handle.** Holds clear handles, and a parked member
  must stay in its delivery.
- **`queue` as the reservation.** It stores the fact twice and refuses parked
  tasks.
- **`move` releasing a member.** It is one call, but a move with a hidden side
  effect drops a reservation another session relies on.
- **Agent-written spend counters.** ADR 0026 keeps session telemetry out of the
  store. The cap is a term, and elapsed time is derived.

## Consequences

- The id grammar gains `KEY-dN` beside `KEY-aN` and `KEY-sN`
  ([ADR 0006](0006-human-readable-node-ids.md)). Project keys are uppercase, so
  a `d` id never collides with `KEY-seq`. Verbs that cannot act on a delivery
  refuse its id as a behavioral error, not a parse error.
- Both stores gain a `delivery` table and a `delivery_history` table, and
  `project` gains `last_delivery_seq`. Tasks gain a nullable `delivery` column.
  The store export and import carry all three.
- The CLI, MCP, and wire gain `create delivery`, `get` and `update` on a
  `KEY-dN` id, a list read of a project's deliveries, the `--delivery` option on
  `update` and `next`, the reused verbs, and `land`. The contract snapshot and
  the version window change with them
  ([ADR 0038](0038-device-pairing-and-the-version-window.md)).
- A project that never creates a delivery behaves exactly as before.
- The work lands in four pull requests: the record (MMR-676), membership
  (MMR-682), the verbs with `land` and the releasing `abandon` (MMR-683), and
  the board rules (MMR-684). ADR 0001 gains a refinement for the dependency
  rule and the `done` refusal with MMR-684.
