---
description: Canonical terms for Mimir’s client/host boundary, task session ownership, task lifecycle steps, and deliveries.
---

# Mimir glossary

This glossary defines the client and host boundary terms used in
[ADR 0034](decisions/0034-engine-interface-and-trpc-wire.md),
[ADR 0035](decisions/0035-tanstack-start-container-host.md),
[ADR 0038](decisions/0038-device-pairing-and-the-version-window.md), and
[ADR 0041](decisions/0041-agent-runtime-on-the-host.md), the task lifecycle
terms used in [ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md),
the delivery terms used in [ADR 0042](decisions/0042-the-delivery-record.md),
and the decision record in [ADR 0043](decisions/0043-the-decision-record.md).

**Host**: The Mimir server that serves the operator console and remote clients
and owns their shared store.

**Store owner**: The sole Mimir authority for a store, either a local CLI or
one host. Remote clients access a host-owned store through that host.

**Pairing**: The one-time exchange in which a named device asks to join a host
and an operator approves it there, after which that device holds a revocable
credential for it.
Pairing identifies a device; it is not an access boundary.

**Version window**: The range of client versions a host accepts: none older
than its minimum supported client, and none whose minor version is newer than
the host's.

**Main session**: The user conversation or workflow coordinating a task. Its
`harness` and `session` remain the primary return point during an assignment.

**Worker session**: An optional distinct session entrusted with the whole task
lifecycle. It owns implementation, task-state updates, review, and completion,
and may delegate smaller pieces to helper agents. A main session working its
own task has no separate worker identity.

**Helper agent**: An agent delegated a piece of a task by its responsible worker.
Its identity is not attached to the task.

**Staged**: A task whose review and checks passed and whose code is accepted
on its branch, but not yet on `main`. It is not terminal: it leaves by `done`
when the code lands, or by `return` for rework
([ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md)).

**Delivery**: One attempt to deliver a phase, or part of one, on one
integration branch through one milestone pull request. It is a record beside
the work tree with its own lifecycle and hold, and its tasks stay in their
phase ([ADR 0042](decisions/0042-the-delivery-record.md)). Not to be confused
with an agent run.

**Member**: A live task that belongs to a delivery that has not ended.
Membership reserves the task for that delivery, so the board-wide `next` leaves
it out and `queue` refuses it.

**Land**: The verb that ends a delivery when its milestone pull request
merges, moving every staged member to `done` in one transaction.

**Stopped**: A delivery's hold, set by `block`, that says the agent cannot
continue without the operator. Only the operator clears it.

**Paused**: A delivery's hold, set by `park`, that says the operator paused the
attempt on purpose.

**Wake**: The host's message to a delivery's T3 thread when the operator acts on
the delivery or one of its decisions in the console, so the agent reads what
changed without waiting for its next heartbeat
([ADR 0040](decisions/0040-outbound-integrations-and-host-secrets.md)).

**Decision**: A question an agent answered provisionally without stopping
its work. It records the question, the options, the recommendation, the
answer taken, and a class, and it links the tasks built on that answer. It is
`provisional` until the operator confirms or overturns it, and an overturn
annotates every linked task
([ADR 0043](decisions/0043-the-decision-record.md)). A question that stops the
work stays `needs_answers` or `block --on you`. The console's review page also
calls its groups of tasks that need the operator "decisions"; those are tasks,
not decision records.

**Checklist item**: A small, numbered item on a task that is added, then
checked or dropped with a reason. Checked and dropped are final, and items
gate nothing ([ADR 0044](decisions/0044-checklist-items.md)).

**Known limitation**: An edge case a delivery ships knowingly, recorded on
the delivery with `limitation` ([ADR 0042](decisions/0042-the-delivery-record.md),
MMR-691 refinement).

**Declined finding**: A review finding a delivery chose not to act on,
recorded with its reason by `decline`.

**Run journal**: The Scratchpad anchored to a delivery, frozen at close-out
into an artifact that names the delivery and links every task that was ever a
member. Not the pad's numbered Journal section, which is one part of it
([ADR 0027](decisions/0027-scratchpads-are-temporary-episode-state.md), MMR-691
refinement).

**Since read**: `get KEY-dN --since <ts>`: a delivery's snapshot plus every
event after the caller's cursor, with a lagged `as_of` for the next read and
an `id` on each event so repeats can be dropped
([ADR 0042](decisions/0042-the-delivery-record.md), MMR-692 refinement).

**Settle window**: The 5 seconds the since read's `as_of` lags the reading
process's clock, so a write that commits just after a read is read next time.
It is a best-effort bound, not a guarantee.

**Agent run**: One execution of an agent by the host on behalf of a task, such
as a grooming run, recorded as a host-owned row with its state, usage, and
outcome ([ADR 0041](decisions/0041-agent-runtime-on-the-host.md)). An agent
run is not a task's session and changes none of its handles. It is distinct
from the run a queued task is reserved for (ADR 0026), which is a session in an
outside harness, and from a **delivery**.

**Run grant**: The board access an agent run is given: the reads its kind
needs within its project, and writes limited to its own task or to new records
linked only to it, such as a planning artifact. An agent run reaches the board only through its run grant, never through the Engine directly. Not
to be confused with a capability in ADR 0012's sense, a feature of the core.
