---
title: 'ADR 0042: The delivery — one attempt to deliver a phase through one branch'
status: accepted
date: 2026-11-14
---

# ADR 0042: The delivery — one attempt to deliver a phase through one branch

A **delivery** is one attempt to deliver a phase, or part of one, on one
integration branch through one milestone pull request. It is a project-anchored
record beside the work tree, shaped like a seed
([ADR 0020](0020-seeds-grooming-queue-entity.md)). It is not a node. It adds no
stored status to any node and never overrides a rollup. Its tasks stay in
their phase, and each one holds a reference to its delivery.

## Decision

### The record

| Part      | Shape                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------ |
| Id        | `KEY-dN`, allocated per project like seeds (`project.last_delivery_seq`), never reused                 |
| Phase     | The phase the delivery delivers, stored at create and fixed for the delivery's life                    |
| Title     | Text, required                                                                                         |
| Lifecycle | `agreed → running → milestone → landed`, or `abandoned` from any non-terminal value                   |
| Hold      | `none`, `stopped`, or `paused`. A held value carries a reason                                          |
| Agreement | A body text, replaced whole on each write, like a container's `## Next` direction                      |
| Link      | `external_ref`: the milestone pull request, as on a task                                               |
| Handles   | `branch` (integration branch), and the orchestrator's `harness`, `session`, and `thread`               |
| Time cap  | A whole number of minutes, optional. Elapsed time is derived from the first `start` transition         |
| History   | An append-only log of the delivery's lifecycle, hold, and membership changes ([ADR 0003](0003-append-only-transition-log.md)) |

- A delivery is born `agreed` with hold `none`. `landed` and `abandoned` are
  terminal. A terminal delivery has no hold, as a terminal task has none
  (ADR 0001, MMR-616 refinement), and it refuses every write.
- `stopped` means the agent cannot continue without the operator. It is always
  the operator's to clear, so a delivery stores no block owner. `paused` is the
  operator's deliberate pause.
- **The hold words are a deliberate exception** to ADR 0020's "one word across
  tasks and seeds". `block` writes `stopped` and `park` writes `paused` on a
  delivery, as the shaping ruling named them. The verbs keep their claim; the
  word names that claim for an attempt in flight.
- The handles are plain fields that only `create` and `update` write. No hold
  and no lifecycle verb clears them: a stopped or paused delivery is still the
  same attempt on the same branch.
- `thread` is the orchestrator's conversation thread as the host addresses it,
  such as a T3 thread id. It is a general handle, beside `harness` and
  `session`, and names no consumer's concept ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)).
- Elapsed time and spend are not stored. Mimir stores the cap as an agreed term
  and derives elapsed time from the log; other spend stays in the session
  ([ADR 0026](0026-work-state-composition.md)).

### Verbs

The task verbs act on a delivery by id type, because their claim is the same.
`land` is the one new verb. Each delivery verb is its own Engine method, as the
seed verbs are (`seedPark`), and the CLI and MCP verbs dispatch to it by the id
grammar ([ADR 0024](0024-cli-command-taxonomy.md)).

| Verb      | Transition                     | Refuses when                                                                    | Input                    |
| --------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------ |
| `start`   | `agreed → running`             | held; no live member; the agreement is empty                                    | none                     |
| `block`   | hold `none → stopped`          | terminal; already held                                                          | reason, required         |
| `unblock` | hold `stopped → none`          | not stopped                                                                     | none                     |
| `park`    | hold `none → paused`           | terminal; already held                                                          | reason, required         |
| `unpark`  | hold `paused → none`           | not paused                                                                      | none                     |
| `submit`  | `running → milestone`          | held                                                                            | none                     |
| `return`  | `milestone → running`          | held                                                                            | reason, optional         |
| `land`    | `milestone → landed`           | held; any member is live and not `staged`; no member is `staged`                | none                     |
| `abandon` | any non-terminal → `abandoned` | terminal                                                                        | reason, required         |

- A delivery verb refuses the inputs it does not use: the handle flags of task
  `start`, and `block --on`.
- Each refusal names its fix: "add a member with `update <task> --delivery
  KEY-dN`", "set the agreement with `update KEY-dN --agreement …`", "unblock
  it first", and so on.
- **`land`** moves every `staged` member to `done` in the same transaction.
  Each task logs the lifecycle change. The landed tasks keep their reference.
- **`abandon`** releases every live member in the same transaction. A released
  task returns to `todo` and leaves the delivery. It keeps its hold, its hold
  reason, and its block owner. It loses its main and worker handles, as
  `unqueue` clears them. It gets an appended rank when it is unheld and has
  none. Each task logs the lifecycle change with the delivery's reason. These
  are new edges into `todo` (from `in_progress`, `under_review`, and `staged`);
  only `abandon` on a delivery takes them.
- `abandon` on a held delivery ends the hold and logs the release, as a
  terminal verb does on a held task.
- `land` and `abandon` are one store transaction each, and each checks the
  delivery's state and every member's state inside it, so a concurrent write
  cannot leave a partial land or a partial release
  ([ADR 0023](0023-concurrency-and-safety-posture.md)).

### Membership

- A task has a nullable `delivery` field. It is its own field, not a resume
  handle: `park`, `block`, and `unqueue` clear handles (ADR 0026) and leave it.
- **A member** is a live task (not `done` or `abandoned`) whose `delivery`
  names a non-terminal delivery. A task is a member of at most one delivery.
- Every member's parent is the delivery's phase.
- **Joining at create.** `create delivery <title> --phase <phase>` takes every
  live task in the phase that is neither `queued`, `staged`, nor a member of
  another delivery. That includes tasks another session has in progress: the
  delivery's orchestrator takes over the phase's open work. Naming `--task`
  ids takes only those tasks instead, and one ineligible id refuses the whole
  create.
- **Joining later.** `update <task> --delivery KEY-dN` adds a member. It
  refuses unless the task is live and neither `queued` nor `staged`, the
  delivery is non-terminal, the task's parent is the delivery's phase, and the
  task is not already a member of a delivery. To switch deliveries, leave the
  first one.
- **Leaving.** `update <task> --delivery none` removes a member. It refuses a
  `staged` member, whose accepted code is on the delivery's branch: `return`
  it first. It refuses a task that is not a member.
- **Reservation, both ways.** A queued task cannot join, and `queue` refuses a
  member and names `update <task> --delivery none`. A task holds one
  reservation at a time.
- **Move.** `move` of a member refuses and names `update <task> --delivery
  none`. Moving the phase itself is unaffected, because the delivery stores
  the phase.
- **Ending a member.** Task `abandon` on a member clears its reference. `done`
  on a member refuses and names `land`. Other task verbs on a member (`start`,
  `submit`, `stage`, `return`, `park`, `block`) are not gated by the
  delivery's lifecycle or hold.
- **After the end.** A task keeps its reference only when `land` completed it,
  so the reference records the delivery that landed it. A task that names a
  terminal delivery is not a member: it may join a new delivery, and the new
  reference replaces the old one. `update <task> --delivery none` refuses it,
  because it is not a member.
- **The log.** Every membership change (join, leave, release, the clear on task
  `abandon`) is a row in the non-terminal delivery's history, naming the task.
  The task's own log keeps only its lifecycle and hold changes, so
  `transition_log` needs no new kind.

### Board rules

- The board-wide `next` leaves out every member. `next --delivery KEY-dN`
  lists that delivery's ready members.
- **The same-delivery dependency rule.** A prerequisite whose lifecycle is
  `under_review` or `staged` counts as settled for a dependent in the same
  delivery, and for no other dependent. The rule reads the prerequisite's
  lifecycle, not its status word, so a held prerequisite still counts.
  Dependencies stay advisory ([ADR 0001](0001-task-status-two-axes-derived-rollup.md)):
  the rule changes whether the dependent reads `ready` or `awaiting`, and it
  never gates `start`.
- Settledness becomes relative to the dependent. `blocking` applies the same
  rule from the prerequisite's side: a prerequisite is not `blocking` a
  dependent that counts it as settled. `became_ready_at` takes the time the
  prerequisite began to count (its `submit`, or its `done` for an outside
  dependent) and the time the dependent joined, whichever is later.
- A readiness change flows through the existing rollup, so a phase's
  distribution can change when a member's readiness changes. No rollup rule
  changes.

### Out of scope here

The decision record, the limitation and declined-finding lists, the run
journal, the since-cursor read, the T3 wake, and the delivery page are later
phases of the same design. Each records its own ADR or refinement.

## Why

- **A phase is the plan, and a delivery is an attempt.** An attempt has its own
  agreement, branch, pull request, budget, and outcome. On a phase, all of
  those would be fields that stay empty unless the phase is delivered, and a
  failed attempt would share its record with the plan. As its own record, a
  second attempt starts clean, and the abandoned one keeps its history.
- **Store beside, never over.** ADR 0001 rejected a stored status that replaces
  a rollup. A delivery stores its own state and adds none to the tree, so no
  container rule changes. A phase still cannot close early, because `staged`
  is not terminal.
- **The dependency rule is exact.** "A prerequisite under review lets its
  dependent continue" holds only for tasks that share a branch, which means
  tasks in one delivery. Scoping the rule there keeps a dependent outside the
  delivery from reading `ready` on unmerged code.
- **One event is one transaction.** A milestone merge completes every member at
  once (`land`), and an abandoned attempt releases every member at once
  (`abandon`). Per-task writes would leave the board half-landed between calls.
- **Membership is the reservation.** The task's reference keeps other sessions
  off it, which is why `next` leaves members out and `queue` refuses them.
  Using `queue` as well would store the same fact twice.
- **A released task is unowned work.** Abandoning an attempt frees its tasks
  for the next one, so a release clears the owner handles as `unqueue` does,
  and a new session can start the task without a takeover.
- **Join by phase, edit by task.** Delivering a whole phase is the common case,
  so create takes the phase's tasks by default. Removing a member must exist
  anyway (to ship a smaller milestone, remove the unfinished members, then
  `land`), and the same per-task edit adds one.
- **A staged member stays.** Its code is accepted on the delivery's branch.
  Letting it leave, or join from elsewhere, would move accepted code between
  branches on the board while the code stays where it is.
- **`start` and `land` need real members.** `start` requires a live member and
  an agreement, so the lifecycle word `agreed` means the terms exist. `land`
  requires a staged member, so a delivery that delivered nothing cannot land.
- **A held delivery does not advance.** `stopped` and `paused` claim the
  attempt is waiting on the operator. Its lifecycle verbs refuse until the
  hold clears, except `abandon`, which ends the attempt. Task verbs on members
  stay ungated: Mimir records the claims an agent makes and does not police
  its process.
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
- **Logging membership on the task.** It needs a new `transition_log` kind and
  a table rebuild in SQLite, and the delivery's history already holds the
  change with its task.
- **The task hold words on a delivery.** `blocked` and `parked` keep ADR 0020's
  one-word rule, but the shaping ruling chose `stopped` and `paused` for an
  attempt.
- **Agent-written spend counters.** ADR 0026 keeps session telemetry out of the
  store. The cap is a term, and elapsed time is derived.

## Consequences

- The id grammar gains `KEY-dN` beside `KEY-aN` and `KEY-sN`
  ([ADR 0006](0006-human-readable-node-ids.md)). Project keys are uppercase, so
  a `d` id never collides with `KEY-seq`. Verbs that cannot act on a delivery
  refuse its id as a behavioral error, not a parse error.
- Both stores gain a `delivery` table and a `delivery_history` table,
  `project` gains `last_delivery_seq`, and tasks gain a nullable `delivery`
  column. The store export carries both tables, the column, and a fourth
  per-project counter, and its schema version increments. Import writes nodes
  before deliveries and sets the `delivery` column after both, because a
  delivery names a phase and a task names a delivery.
- The CLI and MCP gain `create delivery`, a flat `deliveries` read of a
  project's deliveries, `get` and `update` on a `KEY-dN` id, `--delivery` on
  `update` and `next`, the reused verbs on a `KEY-dN` id, and `land`. ADR 0024
  gains two amendments with MMR-676: `create` also creates a delivery, the one
  record whose creation names a tree parent, and `deliveries` joins the flat
  read verbs as `artifacts` did. The contract snapshot and the version window
  change with them ([ADR 0038](0038-device-pairing-and-the-version-window.md)).
- A project that never creates a delivery behaves exactly as before.
- The work lands in four pull requests: the record (MMR-676), membership
  (MMR-682), the verbs with `land` and the releasing `abandon` (MMR-683), and
  the board rules (MMR-684). ADR 0001 gains refinements with them: the release
  edges into `todo` and the `queue` refusal with MMR-683 and MMR-682, and the
  dependency rule and the `done` refusal with MMR-684.
