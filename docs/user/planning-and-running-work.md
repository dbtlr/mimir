# Plan and run work

Mimir separates structural facts from derived readings. You record the work,
order, dependencies, lifecycle, and holds. Mimir calculates the queue and
rollups.

## Shape the hierarchy

```text
project → initiative → phase → task
```

- A **project** owns one work tree.
- An **initiative** states a goal or durable workstream.
- A **phase** is a testable increment toward that goal.
- A **task** is a discrete outcome with a knowable done state.

Tasks may sit directly under an initiative when a phase would add no useful
meaning. There is no subtask level; use a local checklist or annotation for
execution steps.

## Order the ready queue

Rank is the work order. Priority and size are signals that help filter or judge
work, but they never override rank.

```sh
mimir next
mimir reorder AUR-8 --top
mimir reorder AUR-9 --after AUR-8
```

Rank belongs to tasks only and runs across the whole project, so `--before` and
`--after` take any ranked task in the same project. Phases and initiatives carry
no rank. To run one phase after another, depend on it: `mimir depend AUR-12 --on
AUR-11` holds every task under AUR-12 out of `next` until AUR-11 settles.

This keeps one answer to “what is next?” without maintaining a separate queue.

## Groom tasks

Ready answers whether anything stops a task from running. Grooming answers a
different question: is the task understood well enough to run? A task is
`not_groomed` until someone says otherwise, then `needs_answers` or `groomed`.
You set it with a verb. Mimir never infers it from the description.

```sh
mimir groom AUR-8 groomed
mimir groom AUR-8,AUR-9 groomed "scoped in the sign-in design"
mimir groom AUR-10 needs_answers "which store owns the lock?"
mimir create task "Add the retry wrapper" --parent AUR-4 --groomed
mimir next --eq grooming:groomed
```

List the ids first, then the state, then an optional note. A note becomes an
annotation on each task, and `needs_answers` requires one so the open questions
live beside the task. `create --groomed` is for tasks carved from a finished
design.

`next` keeps its rank order and shows each todo task's grooming state in its
rows. `--eq grooming:groomed` narrows the queue to work that is ready to pick
up. Grooming never gates `start`. If a task you already started hits a
question, `block` it with the question as the reason. Editing a description
leaves the state alone, so re-groom a task whose edit changed what it asks.

## Record dependencies

```sh
mimir depend AUR-9 --on AUR-8
mimir undepend AUR-9 --on AUR-8
```

An unsettled dependency makes a task `awaiting`. A task that other work awaits
is `blocking`. These are derived readings, not editable labels.

## Keep lifecycle true

```sh
mimir start AUR-8
mimir submit AUR-8
mimir return AUR-8 "integration coverage is missing"
mimir done AUR-8
```

Use `abandon` when work is no longer worth completing. Use `reopen` only when a
terminal decision was wrong, not when new follow-up work appears.

Holds answer a different question:

```sh
mimir block AUR-8 "waiting for vendor credentials"
mimir unblock AUR-8
mimir park AUR-9 "deferred until the next release"
mimir unpark AUR-9
```

Block for an external obstruction. Park for a deliberate deferral. Both keep
the underlying lifecycle intact.

## Record direction and context

Use a project's or container's direction for sequencing judgment that cannot be
derived from the tree:

```sh
mimir update AUR --direction "Finish recovery before widening sign-in work."
mimir annotate AUR-8 "Vendor sandbox reproduces the timeout."
```

Do not restate the ready queue in direction prose. `overview` already composes
direction with live state:

```sh
mimir overview
mimir tree AUR
mimir get AUR-8 --col history
```
