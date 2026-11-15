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
  Verbs dispatch by the id kind; see the delivery verbs below.

## Membership

Creation takes every unqueued `todo` task in the phase that is not already a
member, including held tasks. Repeat `--task KEY-N` to select tasks instead;
one ineligible task refuses the whole creation.

`update KEY-N --delivery KEY-dN` joins an unqueued `todo` task in that
delivery's phase. Leave with `update KEY-N --delivery none` before switching
deliveries, queueing, moving, or finishing it alone: `done` refuses a member,
which is finished when its delivery lands. A staged member must `return`
before leaving or being abandoned. Task abandon clears membership. Reopen
clears any delivery reference. A task naming only a terminal delivery is not a
member and cannot leave.

Task `get` carries `delivery`; delivery reads carry `members`, the live
tasks naming the attempt. Joins, leaves, and task abandons append `member`
events in the delivery history, without adding task transition rows.

## Delivery verbs

`start KEY-dN` moves agreed to running. It requires a live member, an agreement,
and no hold. `submit` moves running to milestone; `return` moves milestone
back to running with an optional reason; a blank one records none. Both refuse
a held delivery.

`block KEY-dN "reason"` sets stopped; `unblock` clears stopped. `park KEY-dN
"reason"` sets paused; `unpark` clears paused. Block and park require an unheld,
non-terminal delivery and a reason. Delivery start takes no handle flags and
never fills identity from the shell; delivery block refuses `--on`.
Set delivery handles with `update`; every verb preserves them. A task-only verb
(`queue`, `unqueue`, `stage`, `done`, `reopen`) refuses a delivery id: `done`
names `land`, and the others list the verbs a delivery takes.

`land KEY-dN` ends a milestone attempt. It requires at least one staged member,
every live member staged, and no hold on the delivery or any member. It
completes every staged task atomically, clearing and logging task handles.
Landed tasks retain their delivery reference.

`abandon KEY-dN "reason"` ends any non-terminal attempt and releases all live
members atomically. Worked members return to todo, clearing and logging every
resume handle with the reason; they retain holds and block owners and receive
an appended rank if unheld and rankless. Untouched todo members keep handles
and rank and write no task transition. Every release clears membership and
adds a `released` member history row. Abandon also clears and logs a delivery
hold. Terminal attempts keep their own handles and refuse further writes.

## Board rules

Board-wide `mimir next` omits all members. Use `mimir next --delivery KEY-dN`
for that attempt's ready members, in rank order. A terminal delivery returns
none; a non-delivery id or an archived project refuses the read.

A prerequisite under review or staged counts as settled only for a direct
dependent that is also a member of the same non-terminal delivery. This reads
lifecycle, so even a held prerequisite counts. Other dependents still await
it. `blocking` follows the same rule. Dependencies remain advisory and never
gate `start`; container dependency rules stay unchanged.
