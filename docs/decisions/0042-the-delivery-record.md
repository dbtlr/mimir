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
| Handles   | `branch` (integration branch), and the orchestrator's `host`, `harness`, and `session`                 |
| Time cap  | A whole number of minutes, optional. Elapsed time is derived from the first `start` transition         |
| History   | An append-only log of the delivery's lifecycle, hold, and membership changes ([ADR 0003](0003-append-only-transition-log.md)); see *The log* |

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
  same attempt on the same branch. A terminal delivery keeps them as the
  record of where the attempt ran. A reader judges whether a delivery is live
  by its lifecycle, never by its handles.
- The orchestrator's handles mean what a task's main handles mean
  ([ADR 0026](0026-work-state-composition.md)). When the orchestrator runs in a
  T3 thread, `session` is that thread and `host` is its environment, as for a
  task the host launched in T3 ([ADR 0040](0040-outbound-integrations-and-host-secrets.md)).
  A delivery stores no consumer-named field
  ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)).
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
| `land`    | `milestone → landed`           | held; any member is live and not `staged`; any member is held; no member is `staged` | none                |
| `abandon` | any non-terminal → `abandoned` | terminal                                                                        | reason, required         |

- A delivery verb refuses the inputs it does not use: the handle flags of task
  `start`, and `block --on`. Only flags the caller passed count. The CLI's
  identity fill from the shell environment (ADR 0026) does not run for a
  `KEY-dN` id.
- Each refusal names its fix: "add a member with `update <task> --delivery
  KEY-dN`", "set the agreement with `update KEY-dN --agreement …`", "unblock
  it first", and so on.
- **`land`** completes every `staged` member in the same transaction, as `done`
  completes a task: it sets `completed_at`, clears and records the handles, and
  logs the lifecycle change. A held member refuses the land and names `unblock`
  or `unpark`, so no hold is dropped silently. The landed tasks keep their
  reference.
- **`abandon`** releases every live member in the same transaction, and every
  released task leaves the delivery. It keeps its hold, its hold reason, and
  its block owner.
  - A member that moved past `todo` returns to `todo`. It loses every resume
    handle, and its lifecycle row records them with the delivery's reason, as
    `unqueue` clears and records them. It gets an appended rank when it is
    unheld and has none. The moves from `in_progress`, `under_review`, and
    `staged` back to `todo` are new edges, and only `abandon` on a delivery
    takes them.
  - A member still in `todo` changes only its membership. It keeps its handles
    and its rank and writes no task row, because nothing the delivery did
    reached it. Its release is a row in the delivery's history.
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
- **Only unclaimed work joins.** A task can join only while its lifecycle is
  `todo`, with any hold, and it is not a member. Work another session has
  queued, started, or submitted stays with that session. So everything a member
  does after `todo` happens inside its delivery, and releasing it to `todo`
  undoes only the delivery's own work. This is a declared limitation: a task
  already in progress cannot join a delivery.
- **Joining at create.** `create delivery <title> --phase <phase>` takes every
  `todo` task in the phase that is not a member of another delivery. Naming
  `--task` ids takes only those tasks instead, and one ineligible id refuses
  the whole create. `--phase` must name a phase, and an initiative refuses.
  Tasks directly under an initiative cannot be delivered.
- **Joining later.** `update <task> --delivery KEY-dN` adds a member. It
  refuses unless the task can join, the delivery is non-terminal, and the
  task's parent is the delivery's phase. To switch deliveries, leave the first
  one.
- **Leaving.** `update <task> --delivery none` removes a member. It refuses a
  `staged` member, whose accepted code is on the delivery's branch: `return`
  it first. It refuses a task that is not a member.
- **Reservation, both ways.** A queued task cannot join, and `queue` refuses a
  member and names `update <task> --delivery none`. A task holds one
  reservation at a time. The console's T3 launch, which queues the task it
  launches, reads a member as `not_ready` at its first step, before it reaches
  T3 ([ADR 0040](0040-outbound-integrations-and-host-secrets.md)).
- **Move.** `move` of a member refuses and names `update <task> --delivery
  none`. Moving the phase itself is unaffected, because the delivery stores
  the phase.
- **Ending a member.** Task `abandon` on a member clears its reference, except
  on a `staged` member, which refuses and names `return`. `done` on a member
  refuses and names `land`. Other task verbs on a member (`start`,
  `submit`, `stage`, `return`, `park`, `block`) are not gated by the
  delivery's lifecycle or hold.
- **After the end.** A task keeps its reference only when `land` completed it,
  so the reference records the delivery that landed it. `reopen` clears a
  task's reference, because the landing it recorded no longer holds; a
  reopened task rejoins only through the join rules. A
  task that names a terminal delivery is not a member, and
  `update <task> --delivery none` refuses it.

### The log

- `delivery_history` has its own closed kind set, `lifecycle`, `hold`, and
  `member`. It does not use the task log's `TransitionKind`. Each row has
  `from_value`, `to_value`, an optional `reason`, a nullable `task` (the task
  id, set only on `member` rows), and `at`. A `member` row is an event, so its
  `from_value` is always null.
- A `member` row's `to_value` says what happened to the task: `joined`, `left`
  (`update --delivery none`), `released` (`abandon` on the delivery), or
  `abandoned` (task `abandon` on a member). `land` writes a `lifecycle` row for
  the delivery, and each landed task logs its own `done`.
- Membership changes add no rows to `transition_log` and no kind to it. Every
  existing task transition kind is unchanged.

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
  dependent that counts it as settled.
- `became_ready_at` (no read derives it yet; MMR-689) keeps ADR 0003's formula and adds two terms. It is the
  latest of the dependent's last readiness-relevant transition, the latest
  `completed_at` among its prerequisites, the latest `submit` of each
  prerequisite that counts by the same-delivery rule, and the latest `member`
  row in any delivery's history that names the dependent or one of its
  prerequisites. A release is such a row, so a released task that reads
  `ready` counts as newly ready.
- A readiness change flows through the existing rollup, so a phase's
  distribution can change when a member's readiness changes. No rollup rule
  changes.

### Archived projects

A delivery follows its project's archive state, as a seed does
([ADR 0015](0015-project-archive-frozen-and-hidden.md),
[ADR 0020](0020-seeds-grooming-queue-entity.md)). Every write to a delivery
refuses while its project is archived, and `deliveries` hides an archived
project's deliveries.

### Out of scope here

The decision record, the limitation and declined-finding lists, the delivery
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
  Using `queue` as well would store the same fact twice. For the same reason,
  only unclaimed `todo` work joins: a delivery never takes over work another
  session holds, so releasing it never resets that session's work.
- **A released task is unowned work.** Abandoning an attempt frees its tasks
  for the next one. A release of a member the attempt worked clears every
  resume handle, as `unqueue` does, so a new session can start the task
  without a takeover. A member the attempt never touched keeps what it had
  before it joined.
- **Join by phase, edit by task.** Delivering a whole phase is the common case,
  so create takes the phase's tasks by default. Removing a member must exist
  anyway (to ship a smaller milestone, remove the unfinished members, then
  `land`), and the same per-task edit adds one.
- **A staged member stays.** Its code is accepted on the delivery's branch.
  Letting it leave, or be abandoned, would take it off the board's account of
  that branch while the code stays there.
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
  record whose creation names a phase, taking `--phase` because a phase is not
  the delivery's parent; and `deliveries` joins the flat read verbs as
  `artifacts` did. The contract snapshot and the version window
  change with them ([ADR 0038](0038-device-pairing-and-the-version-window.md)).
- A project that never creates a delivery behaves exactly as before.
- The work lands in four pull requests: the record (MMR-676), membership
  (MMR-682), the verbs with `land` and the releasing `abandon` (MMR-683), and
  the board rules (MMR-684). Accepted records gain refinements with them:
  - ADR 0001, with MMR-682: `queue`, `move`, `done`, and `abandon` on a
    staged member refuse for a member, and `reopen` clears a task's
    reference.
  - ADR 0040, with MMR-682: the T3 launch reads a member as `not_ready`.
  - ADR 0001, with MMR-683: the release edges into `todo`.
  - ADR 0001, with MMR-684: the same-delivery dependency rule and the
    board-wide `next` leaving out members.
  - ADR 0003, with MMR-684: the two added `became_ready_at` terms.

## Refinement (2026-11-16, MMR-691): known limitations and declined findings

A delivery keeps two append-only lists of what it ships knowingly. A **known
limitation** is an edge case the delivery ships knowingly. A **declined
finding** is a review finding the delivery chose not to act on, with its
reason. Both are general text: Mimir attaches no behavior to either list
([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)).

### The lists

| Field        | Shape                                                                           |
| ------------ | ------------------------------------------------------------------------------- |
| `number`     | A positive integer, numbered from 1 within its delivery across both lists, never reused |
| `kind`       | `limitation` or `declined`                                                      |
| `text`       | The limitation, or the finding. Required and not blank                          |
| `reason`     | Required and not blank for `declined`; null for `limitation`                    |
| `created_at` | The instant the entry was recorded                                              |

- Entries are never edited or deleted. A wrong entry is corrected by a new one
  that says so. The row is its own log, so no `delivery_history` row is written.
- Both lists live in one `delivery_finding` table, keyed by
  `(delivery_id, number)`.

### Verbs

Two flat work-plane verbs, placed by the MMR-678 amendment's test in
[ADR 0024](0024-cli-command-taxonomy.md): an entry is never addressed after it
is written, and the verbs are specific words.

```sh
mimir limitation MMR-d3 "A cancelled run is charged its full reservation"
mimir decline MMR-d3 "Retry the clone on a transient fetch failure" "Filed as MMR-s55"
mimir decline MMR-d3 "Retry the clone on a transient fetch failure" --reason "Filed as MMR-s55"
```

- `decline` takes the finding, then the reason as trailing words or
  `--reason`, as `item drop` does.
- Each verb is its own Engine method (`deliveryLimitation`, `deliveryDecline`)
  and MCP tool (`limitation`, `decline`), and returns the delivery as `get`
  reads it.
- **Any lifecycle.** Both verbs accept a delivery in any lifecycle, `landed` and
  `abandoned` included. This is the one exception to "a terminal delivery
  refuses every write" above: a finding declined in a review after the merge
  still belongs to the attempt it was found in. Holds do not refuse them
  either.
- **One transaction.** Each verb stamps the delivery's `updated_at`, allocates
  the number, and writes in one store transaction, which serializes concurrent
  writers.
- **Errors.** Blank text and a blank or missing decline reason are
  `validation`. An id that is not a delivery is `validation`, naming its kind;
  a missing delivery is `not_found`. Both refuse while the project is archived,
  as every delivery write does.

### Reads

`get KEY-dN` gains three fields, in every view:

- `limitations`: `[{ number, text, created_at }]`, in number order.
- `declined`: `[{ number, finding, reason, created_at }]`, in number order.
- `journal`: the UUID of the live Scratchpad anchored to the delivery, or null
  ([ADR 0027](0027-scratchpads-are-temporary-episode-state.md), MMR-691
  refinement).

The records view prints each list as one line per entry, and omits a list
that is empty. `deliveries` rows do not carry the lists.

### Transfer

- The store export carries `delivery_findings`, in project-key, then
  delivery-sequence, then number order, written after deliveries. Its schema
  version increments, and an older export carries no entries.
- **Import refuses, and doctor reports,** an entry whose delivery is missing; a
  number below 1 or used twice on one delivery; blank text; a kind outside the
  set; a `declined` entry without a reason or a `limitation` with one; or a
  `created_at` that is not a canonical UTC instant.
