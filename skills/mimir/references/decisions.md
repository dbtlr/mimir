# Decisions

Record a question answered provisionally so work can continue. A decision is a
project record (`KEY-qN`), separate from the work tree. Its question, options,
recommendation, answer taken, class, and rationale are fixed at creation.

```sh
mimir decide "Where should snapshots live?" --option "Per task" --option "Per phase" --recommend 1 --class architecture -p MMR --task MMR-12
mimir get MMR-q1
mimir update MMR-q1 --task MMR-14 --untask MMR-12
mimir update MMR-q1 --delivery MMR-d3
mimir update MMR-q1 --delivery none
mimir confirm MMR-q1 "Accepted"
mimir overturn MMR-q2 --option 2 "Phase is the review unit"
```

Use repeated `--option` flags (at least two), required `--recommend N` and
`--class product|architecture|other`. `--take N` defaults to the recommendation.
`--why` records rationale. The project comes from `--delivery`, otherwise `-p`
or the clone binding. An explicit project must agree with the delivery.

Only a provisional decision accepts changes. Update owns task links and the
optional delivery reference. Links name tasks in the same project, including
done tasks. Duplicate links and no-op updates refuse. A delivery must be in the
same project and nonterminal when linked; its reference survives its end.

Confirm accepts the answer taken. Overturn requires another listed `--option`
or a nonblank note, or both. It annotates every linked task in the same
transaction without changing task status. Both answers are terminal; later
changes require a new decision. A task's `get` shows linked decision ids and
lifecycles. Archived projects hide decisions and refuse writes.

A blocking question still uses grooming `needs_answers`, `block --on you`, or a
seed on another board. A provisional decision gates no work-state verb.
