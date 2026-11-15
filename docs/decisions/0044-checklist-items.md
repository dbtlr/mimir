---
title: 'ADR 0044: Checklist items — small items a task adds, then checks or drops'
status: accepted
date: 2026-11-16
---

# ADR 0044: Checklist items — small items a task adds, then checks or drops

A **checklist item** is a small, numbered item on a task. The task's owner
adds it, then checks it when it is done or drops it with a reason when it will
not be done. A delivery's cleanup task keeps its follow-up findings this way
across deliveries, and any other task can keep a short list of the same kind.

Items are general. They carry no delivery link and no tag-named meaning
([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)): the
build-run shaping rejected one tagged item primitive for limitations, declined
findings, and cleanup items, because a reader would then have to know tag
names. Limitations and declined findings are lists on the delivery instead.

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
| `settled_at` | The instant `check` or `drop` recorded, or null while the item is `open`       |

- An item is born `open`. `checked` and `dropped` are final: neither verb
  undoes the other or itself, and no verb reopens an item. A task that needs
  the work again adds a new item. A settled item is then a fact, which keeps
  the since read (phase 4 of the build-run work) to at most two events per
  item.
- Items are never deleted, so the next number is one more than the task's
  highest. No counter is stored.
- The item row is its own log. `created_at` records the add and `settled_at`
  records the check or drop, so no `transition_log` row is written
  ([ADR 0003](0003-append-only-transition-log.md) logs status transitions, and
  an item is not a status).
- Content and reason are stored as given once they are not blank. They are
  not editable. A mistaken item is dropped with a reason that says so.

### Verbs

One command, `item`, takes the action as its first argument, as
`scratch agenda` does:

```sh
mimir item add MMR-12 "Remove the retired --since hint from flag-owners"
mimir item check MMR-12 2
mimir item drop MMR-12 3 "Covered by MMR-14"
```

| Action  | Effect                     | Refuses when                                                      | Input                     |
| ------- | -------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `add`   | Adds an `open` item        | the id is not a task; the content is blank                        | content                   |
| `check` | `open → checked`           | the id is not a task; no such item; the item is settled           | item number               |
| `drop`  | `open → dropped`           | the id is not a task; no such item; the item is settled; no reason | item number, reason       |

- Each action is its own Engine method (`itemAdd`, `itemCheck`, `itemDrop`),
  and the MCP tool is `item`, as `scratch_agenda` is one tool. Each returns the
  task's whole checklist, in number order. The CLI echoes the task id, and its
  records view shows the item the action changed.
- The task can be in any status, `done` and `abandoned` included. A finding
  can arrive after its task closed, and adding it there keeps it with the work
  it belongs to.
- A phase, an initiative, a project, a seed, a delivery, a decision, or an
  artifact id is refused with a behavioral error that names the id's kind.
  An id that is not a Mimir id is a usage error.
- An unknown item number is `not_found`. A settled item refuses with the state
  it is in and when it settled.
- Every action moves the task's `updated_at`, as `annotate` does, because
  activity on a task affects whether it reads as stale.

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

- **Fleet's cleanup task needs a list that outlives one delivery.** Its
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

- **One general tagged item primitive** shared by tasks and deliveries. A
  reader would need to know the tag names to tell a limitation from a cleanup
  item, which ADR 0002 forbids.
- **`uncheck` and `undrop`.** They make an item's state reversible, and so its
  history needs a log of its own. A new item records the same intent.
- **Items gate `done`.** That would turn a reader's cue into a rule Mimir
  enforces, and dependencies and grooming already gate nothing.
- **Editable content.** A changed item no longer says what was checked.

## Consequences

- A new `checklist_item` table, migration 0018 on SQLite and Postgres, keyed by
  `(node_id, number)`.
- Three Engine methods, their wire routes, the `item` CLI command and MCP
  tool, and the `items` facet on `get`.
- The store export's schema version increments, and doctor gains the item
  checks above.
- The since read on a delivery (phase 4) reports a member's item adds and
  settles from `created_at` and `settled_at`.
