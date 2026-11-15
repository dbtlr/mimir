---
title: 'ADR 0043: The decision — a question answered without stopping'
status: accepted
date: 2026-11-15
---

# ADR 0043: The decision — a question answered without stopping

A **decision** records a question an agent answered provisionally so that its
work could continue. The agent takes an answer, records the question, the
options, its recommendation, and the answer taken, and links the tasks it
builds on that answer. The operator later confirms the answer or overturns
it. An overturn tells the agent which tasks to redo.

A decision is a project-anchored record beside the work tree, shaped like a
seed ([ADR 0020](0020-seeds-grooming-queue-entity.md)) and a delivery
([ADR 0042](0042-the-delivery-record.md)). It is not a node, and it adds no
status to any node.

## Decision

### The record

| Part      | Shape                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| Id        | `KEY-qN`, allocated per project (`project.last_decision_seq`), never reused                                |
| Question  | Text, required                                                                                             |
| Options   | An ordered list of at least two texts, numbered from 1. Each is required                                   |
| Recommend | The number of the option the agent recommends                                                              |
| Taken     | The number of the option the agent took. It defaults to the recommendation                                 |
| Class     | `product`, `architecture`, or `other`                                                                      |
| Why       | The agent's rationale, optional                                                                            |
| Delivery  | An optional link to a delivery in the same project                                                         |
| State     | `provisional → confirmed`, or `provisional → overturned`                                                   |
| Outcome   | `overturn_option`, the option the operator chose on an overturn (or none), and `outcome_note`, the operator's note on a confirm or an overturn (or none) |
| Tasks     | The tasks built on the answer: a set of links the decision owns                                            |
| History   | An append-only log of the decision's state, link, and delivery changes ([ADR 0003](0003-append-only-transition-log.md)); see *The log* |

- A decision is born `provisional`. `confirmed` and `overturned` are terminal,
  and a terminal decision refuses every write, links included. An operator who
  later changes their mind about a confirmed answer records a new decision or
  files new work. A confirmed answer is a settled fact, which keeps the cap
  query and the overturn annotations unambiguous.
- The question, options, recommendation, answer taken, class, and why are
  fixed at `decide`. The operator answers the question as it was put to them.
- The class is the agent's judgment of what the answer governs. `product` and
  `architecture` decisions are the ones a run caps (see *Reads*). `other`
  covers the rest.

### Verbs

| Verb       | Effect                         | Refuses when                                                     | Input                                  |
| ---------- | ------------------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| `decide`   | Creates a `provisional` decision | any field is invalid (below)                                   | the record's fields                    |
| `confirm`  | `provisional → confirmed`      | terminal                                                         | note, optional                         |
| `overturn` | `provisional → overturned`     | terminal; neither an option nor a note; the option is out of range or is the one taken | `--option N`, optional; note, optional |
| `update`   | Adds or removes task links, sets or clears the delivery | terminal                                | `--task`, `--untask`, `--delivery`     |

The CLI shape:

```sh
mimir decide "Store snapshots per task or per phase?" \
  --option "Per task" --option "Per phase" \
  --recommend 1 --class architecture \
  --why "Matches how review gates run" \
  --delivery MMR-d3 --task MMR-12
mimir update MMR-q4 --task MMR-14 --untask MMR-12
mimir confirm MMR-q4
mimir overturn MMR-q4 --option 2 "Phase is the review unit"
mimir overturn MMR-q4 "Neither: drop snapshots"
```

- **`decide`** takes the question as its argument. `--option` repeats, at least
  twice. `--recommend N` and `--class` are required. `--take N` defaults to the
  recommendation. `--why`, `--delivery`, and repeated `--task` are optional.
  The project is the delivery's when `--delivery` is given, and otherwise the
  scope (`-s KEY` or the clone's binding). A `--delivery` in another project
  than `-s` names refuses. `decide` validates every field before it writes, so
  one bad `--task` refuses the whole decision.
- **`confirm`** accepts the answer taken. Its note, when given, is the
  outcome note.
- **`overturn`** rejects the answer taken. `--option N` records that the
  operator chose another listed option; a note alone records an answer that is
  not in the list. With both, the note explains the option. An option equal to
  the one taken refuses and names `confirm`, because it confirms the answer.
- **The verbs do not police the actor.** `decide` is the agent's verb and
  `confirm` and `overturn` are the operator's by convention. Mimir records the
  claim a caller makes and does not check who made it, as with `block --on`.
- Each refusal names its fix: "add another `--option`", "pass `--option N` or
  a note", "use `confirm` for the answer taken", "this decision is confirmed;
  record a new decision with `decide`", and so on.
- Every other work-state verb refuses a `KEY-qN` id as a behavioral error, not
  a parse error, and names the verbs a decision takes. Each decision verb is
  its own Engine method, as the seed and delivery verbs are, and `get` and
  `update` dispatch a `KEY-qN` id to the decision methods
  ([ADR 0024](0024-cli-command-taxonomy.md)).

### Task links

- The decision owns its links: a link table of (decision, task) pairs, unique
  per pair. Only decision writes change them: `decide --task` and
  `update KEY-qN --task KEY-N` add a link, and `update KEY-qN --untask KEY-N`
  removes one. No task verb writes a link.
- A link names a task (not a phase or an initiative) in the decision's
  project. The task may have any status, because work already done on the
  answer is exactly what an overturn must reach.
- Adding a task already linked refuses, and removing a task not linked
  refuses. Both name the decision's current links in the hint.
- Links stay writable for as long as the decision is provisional. An agent
  usually decides first and creates the tasks that build on the answer later.
- **Reads, both ways.** `get KEY-qN` carries `tasks`, the linked task ids.
  A task read carries `decisions`: each linked decision's id and state, in id
  order. The task field is derived from the link table, never stored on the
  task, as a seed's `spawned` list is read from a task's side through
  `upstream`.

### The delivery link

- `--delivery KEY-dN` names a delivery in the decision's project that is not
  terminal. `update KEY-qN --delivery none` clears the link while the
  decision is provisional.
- The link records which attempt raised the question. It gates nothing: a
  decision can link tasks that are not the delivery's members, and the
  delivery's verbs never read its decisions.
- A decision keeps its delivery link after the delivery ends, as a landed task
  keeps its delivery reference.

### The overturn annotation

- `overturn` annotates every linked task in the same store transaction as the
  state change. The annotation names the decision and the operator's answer:
  - `decision KEY-qN overturned: option N (<option text>)`
  - `decision KEY-qN overturned: option N (<option text>): <note>`
  - `decision KEY-qN overturned: <note>`
- Unlike `triage`, which skips settled tasks
  ([ADR 0020](0020-seeds-grooming-queue-entity.md)), the overturn annotates a
  linked task whatever its status. A `done` task built on an overturned
  answer is the one most in need of redoing.
- The annotation changes no status, grooming state, or hold. The agent
  decides what to redo, and records it with the existing verbs.
- `confirm` annotates nothing. A confirmed answer asks for no action.

### Asking the operator

A decision is for a question that does not stop the work. The three forms
that do stop it keep their meanings:

- `needs_answers` grooming: a task that cannot be worked until a question is
  answered ([ADR 0033](0033-task-grooming-state.md)).
- `block --on you`: a started task the operator must unblock.
- A seed: a request for work on another board.

A decision changes no task's grooming state, hold, or readiness, and a
provisional decision gates no verb. A run's cap on provisional decisions is a
term of the run, applied by the agent from the reads below.

### Reads

- `get KEY-qN` returns the whole record with its links and history.
- A flat `decisions` read lists a project's decisions, provisional by default,
  with filters by state, class, delivery, and whether any task is linked. The
  cap query is that read narrowed to provisional `product` and `architecture`
  decisions with at least one linked task, optionally in one delivery. The
  overview counts a project's provisional decisions. These reads are the
  delivery's agent-facing view of the record; this ADR fixes their meaning,
  and they ship after the record.

### The log

- `decision_history` has its own closed kind set: `state`, `link`, and
  `delivery`. Each row has `from_value`, `to_value`, an optional `reason`, a
  nullable `task` (set only on `link` rows), and `at`.
- A `state` row records `provisional → confirmed` or
  `provisional → overturned`. Its reason is the outcome note.
- A `link` row is an event, so its `from_value` is always null. Its
  `to_value` is `linked` or `unlinked`, and its `task` names the task. The
  links that `decide` writes log `linked` rows too.
- A `delivery` row records the delivery link's old and new ids, either of
  which may be null.
- Decision writes add no rows to `transition_log`. The overturn annotations
  are ordinary task annotations.

### Archived projects

A decision follows its project's archive state, as a seed and a delivery do
([ADR 0015](0015-project-archive-frozen-and-hidden.md)). Every write to a
decision refuses while its project is archived, and the `decisions` read
hides an archived project's decisions.

## Why

- **A question that stops nothing still needs an answer of record.** An agent
  that waits for every answer makes the operator its scheduler. An agent that
  takes its recommendation and keeps going needs somewhere to say so, and the
  operator needs one place to answer. An annotation has no state and no
  links, and a seed means work nobody has committed to.
- **Its own record, beside the tree.** A decision outlives the delivery that
  raised it and needs an id that a task read can name. A field on a delivery
  would give it neither. The seed and delivery tables already show the shape:
  a project-anchored record with its own lifecycle and history.
- **The decision owns its links.** A task can rest on several decisions, so a
  single task field cannot hold them. Writing the links from one side gives
  one way to do the job; reading them from both sides gives the agent the
  task's open decisions and the operator the decision's tasks.
- **Terminal means settled.** If `overturn` could follow `confirm`, a
  confirmed answer would stop being a fact a later step can build on, and
  every link would stay open forever. A real change of mind is new
  information, and it gets a new record, as new work after a genuine `done`
  gets a new task.
- **Options are numbered.** The page's answer controls and an overturn's
  `--option` need a stable way to name an option. A free-text note covers the
  answer the list did not foresee.
- **The overturn reaches every linked task.** Settled work built on a wrong
  answer is the work most at risk. Writing the annotations in the overturn's
  transaction means no reader sees an overturned decision whose tasks were
  never told.
- **No actor check.** Mimir records claims and does not police process
  ([ADR 0042](0042-the-delivery-record.md)). The convention of who calls which
  verb belongs to the consumer's process.

## Considered and rejected

- **Links stored on the task.** A task can rest on several decisions, so it
  would need a list field and its own verbs. The link would then have two
  writers.
- **Links writable from both sides.** It is convenient, but it gives two ways
  to do one job.
- **A free-text answer taken.** The agent's taken answer is one of its
  options, so the cap, the page, and an overturn can name it. The operator's
  free-text answer is the overturn note.
- **Options in a body text.** It is richer prose, but options in a body
  cannot back answer controls.
- **`confirmed → overturned`.** See *Terminal means settled*.
- **A seed kind or a tagged annotation.** A seed means uncommitted work, and
  an annotation has no state or links.
- **Embedding decisions in the delivery.** They would have no id for a task
  read to name, and they outlive their delivery.
- **Skipping settled tasks on overturn, as `triage` does.** Triage skips them
  to keep finished work out of the attention rollups. An overturn's whole
  purpose is to reach work built on the answer, finished or not.

## Consequences

- The id grammar gains `KEY-qN` beside `KEY-aN`, `KEY-sN`, and `KEY-dN`
  ([ADR 0006](0006-human-readable-node-ids.md)). Project keys are uppercase,
  so a `q` id never collides with `KEY-seq`.
- Both stores gain a `decision` table, a `decision_task` link table, and a
  `decision_history` table, and `project` gains `last_decision_seq`. The store
  export carries the three tables and a fifth per-project counter, and its
  schema version increments. Import writes decisions after nodes and
  deliveries, because a decision names a delivery and a link names a task.
- The CLI and MCP gain `decide`, `confirm`, and `overturn`, plus `get` and
  `update` on a `KEY-qN` id. A task read gains `decisions`. ADR 0024 gains an
  amendment: `decide` creates a decision, as `seed` creates a seed. The
  contract snapshot and the version window change with them
  ([ADR 0038](0038-device-pairing-and-the-version-window.md)).
- The console's review page already names its groups of tasks that need the
  operator `decisions`. Those are tasks, not decision records. The page that
  shows decision records decides how the two read side by side.
- A project that never records a decision behaves exactly as before.
