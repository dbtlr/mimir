---
title: 'ADR 0045: Operator notifications — events from entries to the needs-you set'
status: accepted
date: 2026-11-18
---

# ADR 0045: Operator notifications — events from entries to the needs-you set

An agent can record a provisional decision and keep building
([ADR 0043](0043-the-decision-record.md)), and a stopped delivery waits for
the operator ([ADR 0042](0042-the-delivery-record.md)). The console lists both
under "Needs you", but only an operator who is looking at the console sees
them. This record settles how the host turns a write into a **notification
event**: what counts as news, who is told, and what an event carries. How an
event reaches a device is a **channel**, and each channel is recorded as a
refinement of this ADR.

## Decision

### The notifier compares sets and knows no verbs

The **needs-you set** is the set that
[ADR 0019](0019-meridian-console-design-system.md)'s MMR-694 refinement
defines: stopped deliveries, provisional decisions, tasks blocked with owner
`you`, and unheld `todo` tasks whose grooming state is `needs_answers`. The
notifier uses the unscoped set across every active project, which
`console.review` returns.

A member's identity is its entry in that read's `queue`: one of the three
kinds `delivery`, `decision`, and `task`, with the record's id.

The **notifier** is a module of the console server (`packages/host/src/server`).
It remembers the last set of identities it read. A **check** reads the set
again and compares:

- An identity in the new set and not in the remembered set is an **entry**.
- An identity that was absent at one check and is present at a later one is
  an entry again.
- An identity that stays in the set is never an entry, whatever changed on the
  record. A task that needs answers and is then blocked on the operator keeps
  its identity, so it is not an entry.

After every successful check the new set replaces the remembered one. The
notifier has no rule for any verb. A new way for a record to enter the set
notifies with no change to the notifier, and a new kind of member fails to
compile until it has an event kind, a text, and a target below.

A check calls `console.review` with the current instant and the fixed zone
`UTC`. The read requires a zone ([ADR 0034](0034-engine-interface-and-trpc-wire.md)),
and neither `queue` nor the needs-you rows depend on it. The read computes
more than the notifier uses. Its cost is bounded to one read per window
(below). A narrower read would change the Engine contract and takes its own
record, once this one is measured to be slow.

The contract, the wire, the CLI, and the core gain nothing. The notifier
reaches work state only through Engine reads and writes nothing.

### Each caller's view marks its mutations

The host hands each caller its own **view** of the one Engine. A view calls
the Engine unchanged. Around each mutation it tells the notifier three things:
the mutation **began**, with the view's actor (below), before the Engine is
called; then that it **succeeded** or **failed**. A query tells the notifier
nothing. The Engine contract's `kind` field says which methods are mutations.

A mutation that fails is forgotten at once. A mutation that succeeds is a
**signal**. A cause (below) is only an actor, so the notifier keeps, for each
actor, the number of mutations in flight and the instant of the latest
success. Its memory does not grow with the number of writes.

### A signal opens a window, and a window ends in one check

- A **window** opens at the first signal that arrives when no window is open.
- It closes 2 seconds after its latest signal, or 10 seconds after it opened,
  whichever comes first.
- When a window closes, a check is due. It runs at once when no check is
  running, and otherwise when the running check ends. At most one check waits:
  a window that closes while a check already waits adds nothing.
- A signal that arrives while a check runs or waits opens the next window.

A check is several store reads, not one instant, and a write can commit before
its signal exists. So a check does not ask which window a write belonged to:

- A check's **causes** are the actors of every mutation that had begun and was
  not yet retired when the check's read returned. That includes a mutation
  still in flight and one that succeeded while the check was reading.
- A successful check **retires** the mutations that had succeeded before its
  read began. A later mutation stays, and counts again as a cause of the next
  check. So an actor is a cause when it has a mutation in flight, or when its
  latest success is not earlier than the instant the last successful check
  began its read.

A check succeeds only when its read and the building of its events both
succeed. Its reads have 30 seconds; a check that takes longer fails, and
whatever the late read returns is ignored. A check that fails is logged as
`needs_you_check_fault`. It replaces nothing and retires nothing, so its
causes carry to the next check, which the next window brings.

**Boot.** The notifier reads the set once before the host serves any request,
remembers it, and emits nothing. That read has the same 30 seconds. A failure
of it is logged as `needs_you_check_fault` and never refuses startup. Boot
runs once: a second call does nothing. A notifier with no remembered set treats its next successful
read as the first and emits nothing for it.

**Close.** Closing the host cancels an open window and a waiting check. The
result of a running check is discarded and logs nothing. Close does not wait
for a delivery in flight. After close the notifier ignores everything a view
tells it.

The window and the marks are timed on a monotonic clock, so a step of the
wall clock changes neither a window's length nor which mutations a check
retires. Only the instant handed to the review read comes from the wall clock.

The remembered set, the marks, and the window live in memory only. Every
member enters the set through a write, and none enters because time passed,
so the notifier has no timer besides the window.

### An event reaches a recipient unless they caused it

An **actor** is who made a write. A **recipient** is who receives events. The
events of a check reach a recipient unless the check has at least one cause
and every cause is that recipient. A check with no causes reports its
entries.

There are two actors today:

| Actor      | Writes                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| `operator` | The console's server functions, and the T3 adapter's writes for a console action           |
| `other`    | The `/trpc` handler (a paired CLI or MCP server), and an agent run's grant ([ADR 0041](0041-agent-runtime-on-the-host.md)) |

There is one recipient today, the operator. So a check that has causes, all
of them `operator`, emits no event, and any other check emits an event for
each entry it found. The remembered set is replaced either way, so an entry the operator
caused is never reported later. A check that withholds its entries logs
`needs_you_withheld` with their ids.

The rule errs toward notifying: one `other` cause is enough to report every
entry of the check.

The wake ([ADR 0040](0040-outbound-integrations-and-host-secrets.md)) covers
the other direction. It tells a delivery's agent when the operator acts on the
delivery or its decisions in the console.

### The event

| Field       | Shape                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `kind`      | `delivery_stopped`, `decisions`, `task_blocked`, or `task_needs_answers` |
| `ids`       | The members' ids. More than one only for `decisions`                     |
| `project`   | The project key                                                          |
| `title`     | One line of text (below)                                                 |
| `body`      | One line of text (below)                                                 |
| `target`    | The console path that opens the record                                   |
| `needs_you` | The size of the needs-you set at this check                              |

The event kind and the text come from the member's row in the read's
`needsYou`, which carries a task's reason and each record's text.

Each entry becomes one event, except decisions. The decision entries one check
finds that name the same delivery form one event, and those with no delivery
form one event per project. A check emits its events in `queue` order, and a
`decisions` event takes the place of its first member.

`kind` and `target` together identify what an event is about. A channel can use
them to replace an earlier notification about the same record, where its
platform supports that. A `decisions` event counts the entries of its own
check, not every provisional decision of the delivery or project.

`needs_you` is for a channel that shows a count. It is the size at the check
that emitted the event. No event is emitted when a member leaves the set, so
the count a channel last showed can be too high.

| Kind                 | Title carries                                           | Body carries                                         | Target                     |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| `delivery_stopped`   | The delivery's title                                    | The hold reason, or the delivery's id when it has none | `/p/KEY/dN`              |
| `decisions`          | The count when above one, and the delivery or project   | The first member's question                          | `/p/KEY/dN?mode=decisions`, or `/p/KEY?mode=decisions` with no delivery |
| `task_blocked`       | The task's title                                        | The hold reason, or the task's id when it has none   | `/p/KEY/SEQ`               |
| `task_needs_answers` | The task's title                                        | The open question, or the task's id when it has none | `/p/KEY/SEQ`               |

- The table names what each line carries. The words around those parts belong
  to the implementation and can change without a new decision.
- A `decisions` title names its delivery by title. The decision row carries
  only the delivery's id, so the notifier reads the delivery; when that read
  fails, the title uses the id. With no delivery, the title names the project
  by its key.
- Text is plain. Runs of whitespace collapse to one space. A title is at most
  100 characters and a body at most 240; a longer text is cut so that it ends
  in an ellipsis inside that limit.
- `?mode=decisions` is reserved for the decisions walkthrough (MMR-703), a
  console page that walks the provisional decisions of one delivery, or of one
  project when they name no delivery. Until that page exists the console
  ignores the mode and shows the record's page, which lists the decisions.

### Channels

A **channel** delivers events: `deliver(event)` returns a promise. The notifier
hands each event to every channel once and does not retry; a channel owns its
own retries. The notifier does not wait for a delivery before its next check.
A channel that rejects, or throws, is logged as `needs_you_channel_fault`, and
the other channels still receive the event.

The notifier runs on every host, with or without a channel. It logs each event
as `needs_you_event` with the kind, the ids, the target, and the count, and
never the title or the body. Each of its log lines is one JSON object with
`event` and `time`, the form of the host's other named events. With no channel, its log lines are its only
output.

### The notifier never touches the write

What a view tells the notifier is synchronous, does no I/O, and cannot throw.
A view returns the mutation's own result or error, and never waits for the
notifier.

## Known limits

- A command the operator types into a paired CLI is an `other` write, because
  the host cannot tell it from an agent's. It notifies.
- A check with one `other` cause reports every entry it found, the operator's
  own included. That happens, for example, when console writes and other
  writes share a window, when a write lands or is still in flight while a
  check is reading, when two windows share one waiting check, and when an
  earlier check failed and left its causes for this one.
- An event follows its write by up to 10 seconds plus the check, and by longer
  when a check is already running.
- Only decisions group. A write that puts several deliveries or tasks into the
  set at once produces one event each.
- An entry is lost when the host stops before its check runs, when its check
  fails and no later write follows, and when it enters before the first
  successful read of a host whose boot read failed.
- A mutation that commits and then fails while building its answer counts as
  failed, so it opens no window. Its entry is found by the next check and
  reported or withheld by that check's causes.
- A member that enters and leaves before its check is never reported. A member
  that leaves and returns between two checks is not an entry: a task whose
  question is answered and asked again inside one window is not reported
  again.
- The notifier sees only the writes made through its own host process:
  - `mimir-host store import --apply` writes the store with no Engine call.
    Imported members are found by the next check, and reported or withheld by
    that check's causes.
  - During an overlapping deploy two host processes serve one store, each with
    its own remembered set. An entry made through one can be reported again by
    the other, or taken into its set unreported.

## Why

- **The set is already derived.** A task enters it through `block`, through
  `groom`, and through `unpark` or `unblock` on a task that needs answers, for
  example. Rules per verb would copy that derivation and drift from it.
- **The window is one mechanism for two needs.** It bounds the cost to one
  read however many writes arrive, and it groups an agent's burst of
  decisions.
- **One host process sees the writes made through it.** The CLI, MCP, the
  console, and agent runs reach a host's store through its one Engine
  (ADR 0034, decision 8).

## Considered and rejected

- **A hook on each verb.** Rejected above: it copies the derivation.
- **Notifying at once, with no window, as the wake does.** ADR 0040 rejected
  batching wakes over a window, because it needs a timer and loses the pending
  wake at a restart. A wake answers one operator action, so nothing there
  needs grouping. Here a check per write costs one review read per write, and
  an agent's burst of decisions would arrive as separate notifications. The
  timer and the loss at a restart are accepted and listed under Known limits;
  the record stays in the console's needs-you list either way.
- **Attribution per write.** A check after every write would say which write
  caused which entry, at the price of one review read per write, and a write
  that lands during the read would still be ambiguous.
- **A stored ledger of reported members.** It would save only the check that
  is pending when the host stops.
- **Notifying from the core.** The core carries no concept of any integration
  ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md),
  ADR 0040).
- **A switch for the notifier.** With no channel its cost is one review read
  per window, and its log lines are how a missing notification is diagnosed. A
  setting with no other consumer was not worth its configuration.

## Consequences

- A channel is added as a refinement of this ADR. It decides its own setting,
  storage, and failure states under ADR 0040.
- The rule names actors and recipients, never a transport. A host with several
  users needs more than that: every device token belongs to the one user
  `owner` today ([ADR 0038](0038-device-pairing-and-the-version-window.md)), so
  an actor would also have to tell a user from an agent that writes with that
  user's token. That design is not settled here.
