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

The **needs-you set** is the set of members that `console.review` returns in
`queue`: stopped deliveries, provisional decisions, tasks blocked with owner
`you`, and unheld `todo` tasks whose grooming state is `needs_answers`, across
every active project. A member's identity is its kind and its id.

The **notifier** is a module of the console server (`packages/host/src/server`).
It remembers the last needs-you set it read. A **check** reads the set again
through the Engine and compares:

- A member in the new set and not in the remembered set is an **entry**.
- A member that left the set and is in it again at a later check is an entry
  again.
- A member that stays in the set is never an entry, whatever changed on it
  (its rank, its text, its hold reason).

After every successful check the new set replaces the remembered one. The
notifier has no rule for any verb. A new way for a record to enter the set
notifies with no change to the notifier, and a new kind of member fails to
compile until it has a kind, a text, and a target below.

The contract, the wire, the CLI, and the core gain nothing. The notifier
reaches work state only through Engine reads and writes nothing.

### A write opens a window, and a window ends in one check

Every Engine mutation made through the host that succeeds **signals** the
notifier with its actor (below). A query signals nothing, and a mutation that
throws signals nothing. The Engine contract's `kind` field says which methods
are mutations.

- A **window** opens at the first signal after the previous window closed.
- It closes 2 seconds after its latest signal, or 10 seconds after it opened,
  whichever comes first.
- When it closes, one check runs. Checks never overlap: a signal that arrives
  while a check runs opens the next window.
- At boot the notifier reads the set once, remembers it, and emits nothing. A
  notifier that has no remembered set, because that read failed, treats its
  next successful read as the first and emits nothing for it.

The remembered set and the open window live in memory only. The host is the
only writer of its store ([ADR 0035](0035-tanstack-start-container-host.md)),
so no member can enter the set while the host is down.

Every member of the set enters through a write. None enters because time
passed, so the notifier has no timer besides the window.

### An event reaches a recipient unless they caused it

An **actor** is who made a write. A **recipient** is who receives events. An
event reaches a recipient unless every signal in its window came from that
recipient.

There are two actors today:

| Actor      | Writes                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| `operator` | The console's server functions, and the T3 adapter's writes for a console action           |
| `other`    | The `/trpc` handler (a paired CLI or MCP server), and an agent run's grant ([ADR 0041](0041-agent-runtime-on-the-host.md)) |

There is one recipient today, the operator. So a window whose signals all came
from the console produces no event, and any other window produces an event for
each entry in it. The remembered set is replaced either way, so an entry the
operator caused is never reported later.

The host hands each caller its own view of the one Engine. A view calls the
Engine unchanged and signals with its actor after a mutation succeeds. The
rule names actors and recipients, never a transport, so it holds unchanged
when an actor becomes a user's identity.

This is the mirror of the wake
([ADR 0040](0040-outbound-integrations-and-host-secrets.md)): a console write
tells the agent, and any other write tells the operator.

### The event

| Field       | Shape                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `kind`      | `delivery_stopped`, `decisions`, `task_blocked`, or `task_needs_answers` |
| `ids`       | The members' ids. More than one only for `decisions`                     |
| `project`   | The project key                                                          |
| `title`     | One line that names the kind and the record                              |
| `body`      | One line of the record's own text                                        |
| `target`    | The console path that opens the record                                   |
| `needs_you` | The size of the needs-you set at this check                              |

Each entry becomes one event, except decisions. Decision entries in one window
that name the same delivery form one event, and decision entries with no
delivery form one event per project.

| Kind                 | Title names                                             | Body carries                                     | Target                     |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `delivery_stopped`   | The delivery's title                                    | The hold reason                                  | `/p/KEY/dN`                |
| `decisions`          | The count when above one, and the delivery or project   | The oldest entry's question                      | `/p/KEY/dN?mode=decisions`, or `/p/KEY?mode=decisions` with no delivery |
| `task_blocked`       | The task's title                                        | The hold reason, or the task's id when it has none | `/p/KEY/SEQ`             |
| `task_needs_answers` | The task's title                                        | The open question, or the task's id when it has none | `/p/KEY/SEQ`           |

- A `decisions` title names its delivery by title. The decision row carries
  only the delivery's id, so the notifier reads the delivery; when that read
  fails, the title uses the id.
- Text is plain. Runs of whitespace collapse to one space, a title is cut to
  100 characters and a body to 240, and a cut ends in an ellipsis.
- `?mode=decisions` is the address of the decisions walkthrough. A console
  that does not know the mode shows the record's page.

### Channels

A **channel** delivers events: `deliver(event)` returns a promise. The notifier
hands each event to every channel once and does not retry; a channel owns its
own retries. A channel that rejects is logged as `needs_you_channel_fault` and
the other channels still receive the event.

The notifier runs on every host, with or without a channel. It logs each event
as `needs_you_event` with the kind, the ids, the target, and the count, and
never the title or the body. With no channel, that line is its only output.

### The notifier never touches the write

- A signal is synchronous, does no I/O, and cannot throw. A view returns the
  mutation's own result or error, and never waits for the notifier.
- A check that fails is logged as `needs_you_check_fault`. The remembered set
  stays, and the failed window's actors carry into the next window, which opens
  at the next signal.
- Closing the host cancels an open window.

## Known limits

- A command the operator types into a paired CLI is an `other` write, because
  the host cannot tell it from an agent's. It notifies.
- A window that mixes console writes with other writes notifies for every
  entry in it, the operator's own included.
- An event lags its write by 2 to 10 seconds.
- A window that is open when the host stops is lost, and so is the entry of a
  write whose check failed when no later write follows.
- A member that enters and leaves inside one window is never reported.

## Why

- **The set is already derived.** A task enters it through `block`, through
  `groom`, and through `unpark` or `unblock` on a task that needs answers.
  Rules per verb would copy that derivation and drift from it.
- **The window is one mechanism for three needs.** It bounds the cost to one
  read however many writes arrive, it groups an agent's burst of decisions,
  and it decides attribution.
- **The host is the one place that sees every write.** The CLI, MCP, the
  console, and agent runs all reach the store through one Engine in one
  process.

## Considered and rejected

- **A hook on each verb.** Rejected above: it copies the derivation.
- **Attribution per write.** A check after every write would say exactly which
  write caused which entry, at the price of one review read per write. The
  window errs toward notifying, which is the safe error.
- **A stored ledger of reported members.** It would save only the window that
  is open when the host stops.
- **Notifying from the core.** The core carries no concept of any integration
  ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md),
  ADR 0040).
- **A switch for the notifier.** With no channel its cost is one review read
  per window, and its log line is how a missing notification is diagnosed. A
  setting with no other consumer was not worth its configuration.

## Consequences

- A channel is added as a refinement of this ADR. It decides its own setting,
  storage, and failure states under ADR 0040.
- When the host has several users, an actor and a recipient become user
  identities and the needs-you set becomes one set per recipient. The rule
  above does not change.
