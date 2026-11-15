---
title: 'ADR 0044: Checklist items — small items a task adds, then checks or drops'
status: accepted
date: 2026-11-16
---

# ADR 0044: Checklist items — small items a task adds, then checks or drops

A **checklist item** is a small, numbered item on a task. A caller adds it,
then checks it when it is done or drops it with a reason when it will not be
done. A cleanup task that collects review follow-ups from several deliveries
([ADR 0042](0042-the-delivery-record.md)) keeps them this way, and any other
task can keep a short list of the same kind.

Items are general. They carry no delivery link and no tag-named meaning
([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)). One
tagged item primitive for a delivery's known limitations, its declined
findings, and cleanup items was rejected, because Mimir's own delivery reads
would then have to interpret tag names, which ADR 0002 forbids the core to do. Limitations and declined findings are lists on the delivery
instead, recorded with the delivery journal.

## Decision

### The record

| Field        | Shape                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| `task`       | The task that holds the item. Only a node of type `task` holds items           |
| `number`     | A positive integer, numbered from 1 within its task, never reused              |
| `content`    | Text, required and not blank                                                   |
| `state`      | `open`, `checked`, or `dropped`                                                |
| `reason`     | Required and not blank for `dropped`; null for `open` and `checked`            |
| `created_at` | The instant `add` recorded the item                                            |
| `settled_at` | The instant `check` or `drop` recorded, or null while the item is `open`. It is never earlier than `created_at`: a settle whose clock reads earlier records `created_at` instead |

- An item is born `open`. `checked` and `dropped` are final: neither verb
  undoes the other or itself, and no verb reopens an item. A task that needs
  the work again adds a new item. A settled item is then a fact, and a
  reader of its history sees at most two events: the add and the settle.
- Items are never deleted, so the next number is one more than the task's
  highest. No counter is stored.
- The item row is its own log. `created_at` records the add and `settled_at`
  records the check or drop, so no `transition_log` row is written
  ([ADR 0003](0003-append-only-transition-log.md) logs status transitions, and
  an item is not a status).
- Content and reason are stored as given once they are not blank. They are
  not editable. A mistaken item is dropped with a reason that says so.

### Verbs

`item` is a work-plane noun group with three subcommands, by the amendment to
[ADR 0024](0024-cli-command-taxonomy.md) below:

```sh
mimir item add MMR-12 "Remove the retired --since hint from flag-owners"
mimir item check MMR-12 2
mimir item drop MMR-12 3 "Covered by MMR-14"
```

| Subcmd  | Effect                     | Refuses when                                                      | Input                     |
| ------- | -------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `add`   | Adds an `open` item        | the id is not a task; the content is blank                        | content                   |
| `check` | `open → checked`           | the id is not a task; no such item; the item is settled           | item number               |
| `drop`  | `open → dropped`           | the id is not a task; no such item; the item is settled; no reason | item number, reason       |

- **Output.** Every subcommand returns the same shape, the task's whole
  checklist in number order:

  ```json
  { "task": "MMR-12",
    "items": [ { "number": 1, "content": "…", "state": "dropped",
                 "reason": "Covered by MMR-14",
                 "created_at": "2026-11-16T09:00:00.000Z",
                 "settled_at": "2026-11-16T10:00:00.000Z" } ] }
  ```

  `reason` and `settled_at` are `null` when the record has none. The CLI's
  `json` view prints this object, `ids` prints the task id, and `records`
  shows the item the subcommand changed.
- **One transaction.** Each subcommand runs in one store transaction. It stamps
  the task's `updated_at` first, which serializes concurrent writers on the
  task row, then allocates the number or checks the item's state, writes, and
  reads the checklist back. Two concurrent adds on one task get consecutive
  numbers; two concurrent settles of one item leave one settled and the other
  refused as settled.
- Each subcommand is its own Engine method (`itemAdd`, `itemCheck`,
  `itemDrop`) and its own MCP tool (`item_add`, `item_check`, `item_drop`),
  with typed inputs: the task id, then the content, the number, or the number
  and the reason. Each returns the task's whole checklist, in number order.
  The CLI echoes the task id, and its records view shows the item the
  subcommand changed.
- The task can be in any status, `done` and `abandoned` included. A finding
  can arrive after its task closed, and adding it there keeps it with the work
  it belongs to.
- A phase, an initiative, a project, a seed, a delivery, a decision, or an
  artifact id is refused as `validation`, naming the id's kind.
  An id that is not a Mimir id is `not_found`, as on `annotate`.
- **Errors.** The CLI refuses an item number that is not a positive integer
  as a usage error, before the store opens, as `scratch agenda` does; the
  Engine schema refuses it as `validation`. A missing task is `not_found`.
  Blank content and a blank or missing drop reason are `validation`. An
  unknown item number is `not_found` (`MMR-12 has no item 7`). A settled item
  is `conflict`, naming its state and when it settled
  (`MMR-12 item 2 is already checked (2026-11-16 10:00)`).
- Every subcommand moves the task's `updated_at`, as `annotate` does, because
  activity on a task affects whether it reads as stale.

### The ADR 0024 amendment

ADR 0024 makes every work-state mutation a flat top-level verb and allows
Scratchpads the only noun group, an exception it says does not generalize.
Items are a second exception, for one of the reasons Scratchpads are one: an
item is a numbered sub-record inside a task, and its operations are generic
words. Flat, `check` and `drop` would sit at the top level beside `done` and
`abandon`, where `mimir drop MMR-12 3` reads as deleting the task, and other
records' sub-items could claim the same words later. The group keeps those
words scoped to a checklist. The amendment, with its placement test, is
recorded in ADR 0024 itself.

### Reads

- `get <task>` carries the task's items in number order. The `json` and
  `jsonl` views always include them as `items`, an array of the record's
  fields without `task`. The records view shows a one-line count by state
  (`2 open · 1 checked · 1 dropped`), and `--col items` expands it to one line
  per item, as `--col annotations` expands notes.
- No list, overview, or board read counts items, and no item changes a task's
  status, rollup, or rank. Items gate nothing: a task can be `done` with open
  items, and an open item is a reader's cue, not a rule.

### Archived projects

Items follow their project's archive state
([ADR 0015](0015-project-archive-frozen-and-hidden.md)). Every item action
refuses while the project is archived, as every other node write does.

### Transfer

- The store export carries `checklist_item`. Its schema version increments. An
  export of an older version reads as having no items.
- Items export in project-key, then task-sequence, then item-number order.
  Import writes them after nodes.
- **Import refuses, and doctor reports,** an item that breaks a rule the verbs
  keep: a missing task or a node that is not a task; a number below 1 or a
  number used twice on one task; blank content; a state outside the set; a
  `dropped` item without a reason, or another state with one; an `open` item
  with a `settled_at`, or a settled item without one; or a `settled_at`
  before its `created_at`.

## Why

- **A cleanup task needs a list that outlives one delivery.** Its
  findings arrive from several runs, each one settles separately, and the
  operator wants to see which are done. Annotations are free text and cannot
  be checked off. Child tasks are too heavy for a one-line finding, and they
  would change the tree's rollups.
- **Final states keep the record honest.** An item that can be unchecked
  makes its own history ambiguous, and the since read would need a log for
  every flip. Adding a new item is cheap.
- **Tasks only.** A phase or an initiative is a plan whose state is derived
  from its children ([ADR 0001](0001-task-status-two-axes-derived-rollup.md)). A list
  on a container would be work outside any task, which the tree already says
  belongs in a task.

## Considered and rejected

- **One general tagged item primitive** shared by tasks and deliveries.
  Mimir's delivery reads would have to interpret tag names to tell a
  limitation from a cleanup item, which ADR 0002 forbids the core to do.
- **`uncheck` and `undrop`.** They make an item's state reversible, and so its
  history needs a log of its own. A new item records the same intent.
- **Items gate `done`.** That would turn a reader's cue into a rule Mimir
  enforces, and dependencies and grooming already gate nothing.
- **Editable content.** A changed item no longer says what was checked.
- **Flat verbs** (`mimir item MMR-12 "…"`, `mimir tick`, `mimir strike`). They
  follow ADR 0024 as written, but they add three top-level verbs whose words
  read less plainly than `item check` and `item drop`.
- **The Agenda's words** (`complete` and `supersede`, `done` and
  `superseded`). A checklist item is not superseded by another item; it is
  dropped, with a reason. `checked` also keeps `done` for the task status it
  already names.

## Consequences

- A new `checklist_item` table, migration 0018 on SQLite and Postgres, keyed by
  `(node_id, number)`.
- Three Engine methods, their wire routes, the `item` CLI group and its three
  MCP tools, and the `items` facet on `get`.
- The store export's schema version increments, and doctor gains the item
  checks above.
- ADR 0024 gains an amendment for the `item` group.
- The since read on a delivery, a later phase of ADR 0042's design, can report
  item adds and settles from `created_at` and `settled_at` on the tasks it
  covers. Which tasks it covers is that read's own decision; a cleanup task
  outside the delivery is not one of them unless that read says so.
