# Deliveries: one attempt at a phase

A delivery (`KEY-dN`) records one attempt to deliver a phase, or part of one,
on one integration branch through one milestone pull request. It sits beside
the tree, like a seed: it is not a node, and it adds no status to any node.

```sh
mimir create delivery "Ship the phase" --phase MMR-2 --agreement "Terms"
mimir deliveries                 # the bound project's attempts, oldest first
mimir deliveries --project MMR
mimir get MMR-d1                 # the whole record, history included
mimir update MMR-d1 --agreement "Revised terms" --time-cap 60
```

- **The project is the phase's.** `--phase` must name a phase; a task or an
  initiative refuses. A delivery is born `agreed` with hold `none`.
- **Terms are replaced whole.** `--agreement` replaces the agreement and
  `--clear-agreement` clears it; blank agreement text is refused.
  `--time-cap` takes a whole number of minutes, or `none` to clear it.
- **Handles.** `--branch` (the integration branch), `--host`, `--harness`, and
  `--session` (the orchestrator's) are plain fields; blank text clears one, as
  on a task. `--ref` is the milestone pull request.
- **Every read carries the history**, and elapsed time is derived from the
  first start, never stored.
- **Refusals.** A terminal delivery (`landed`, `abandoned`) refuses every
  write. An archived project hides its deliveries and refuses writes to them.
  Task verbs refuse a `KEY-dN` id.

## Membership

Creation takes every unqueued `todo` task in the phase that is not already a
member, including held tasks. Repeat `--task KEY-N` to select tasks instead;
one ineligible task refuses the whole creation.

`update KEY-N --delivery KEY-dN` joins an unqueued `todo` task in that
delivery's phase. Leave with `update KEY-N --delivery none` before switching
deliveries, queueing, or moving. A staged member must `return` before leaving
or being abandoned. Task abandon clears membership. Reopen clears a landed
reference. A task naming only a terminal delivery is not a member and cannot
leave.

Task `get` carries `delivery`; delivery reads carry `members`, the live
tasks naming the attempt. Joins, leaves, and task abandons append `member`
events in the delivery history, without adding task transition rows.
