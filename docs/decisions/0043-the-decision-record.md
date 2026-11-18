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

| Field             | Shape                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `id`              | `KEY-qN`, allocated per project (`project.last_decision_seq`), never reused                               |
| `project_key`, `seq` | The project key and the decision's sequence number, as on a delivery                                   |
| `question`        | Text, required                                                                                            |
| `options`         | An ordered list of at least two texts, numbered from 1, each required. Stored on the decision row as a JSON array of strings |
| `recommended`     | The number of the option the agent recommends                                                             |
| `taken`           | The number of the option the agent took. It defaults to `recommended`                                     |
| `class`           | `product`, `architecture`, or `other`                                                                     |
| `why`             | The agent's rationale, or null                                                                            |
| `delivery`        | A delivery id in the same project, or null                                                                |
| `lifecycle`       | `provisional → confirmed`, or `provisional → overturned`                                                  |
| `overturn_option` | The option number the operator chose on an overturn, or null                                              |
| `outcome_note`    | The operator's note on a confirm or an overturn, or null                                                  |
| `created_at`, `updated_at` | Instants. `updated_at` moves on every write to the decision                                     |
| `tasks`           | The tasks built on the answer: a set of links the decision owns, read in task-sequence order              |
| `history`         | An append-only log of the decision's lifecycle, link, and delivery changes ([ADR 0003](0003-append-only-transition-log.md)); see *The log* |

- A decision is born `provisional`. `confirmed` and `overturned` are terminal,
  and a terminal decision refuses every write, links included. An operator who
  later changes their mind about a confirmed answer records a new decision or
  files new work. A confirmed answer is a settled fact, which keeps the cap
  query and the overturn annotations unambiguous.
- The question, options, recommendation, answer taken, class, and why are
  fixed at `decide`. The operator answers the question as it was put to them.
- **Blank text.** The question and every option must be non-blank, and `decide`
  refuses a blank one. A blank `why` or a blank note counts as absent and is
  stored as null. Text that is not blank is stored as given.
- **Class** is the agent's judgment of what the answer governs. It is a closed
  set because the reads filter on it, and Mimir attaches no behavior to any
  value ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)):
  every decision has a subject, and the three words name the subject
  generally, as a seed's `kind` does.

### Verbs

| Verb       | Effect                         | Refuses when                                                     | Input                                  |
| ---------- | ------------------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| `decide`   | Creates a `provisional` decision | any input is invalid (below)                                   | the record's fields                    |
| `confirm`  | `provisional → confirmed`      | terminal                                                         | note, optional                         |
| `overturn` | `provisional → overturned`     | terminal; neither an option nor a non-blank note; the option is out of range or is the one taken | `--option N`, optional; note, optional |
| `update`   | Adds or removes task links, sets or clears the delivery | terminal; any input is invalid (below)  | `--task`, `--untask`, `--delivery`     |

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
  recommendation, and both must name an option. `--why`, `--delivery`, and
  repeated `--task` are optional. The project is the delivery's when
  `--delivery` is given, and otherwise `--project KEY` (`-p`) or the clone's
  binding, as `seed` resolves its board. A `--project` that disagrees with the
  delivery's project refuses, and so does a call with no project. A task named
  twice refuses. `decide` validates every input inside its store transaction
  before it writes, so one bad `--task`, or a delivery that ended meanwhile,
  refuses the whole decision.
- **`confirm`** accepts the answer taken. Its note, when given, is the
  outcome note.
- **`overturn`** rejects the answer taken. `--option N` records that the
  operator chose another listed option; a note alone records an answer that is
  not in the list. With both, the note explains the option. An option equal to
  the one taken refuses and names `confirm`, because it confirms the answer.
- **`update`** applies all of its flags in one transaction, or none of them.
  It validates every flag against the decision as it stands when the
  transaction begins: each `--task` must name a task not yet linked, and each
  `--untask` a task that is linked. A task named twice, or under both
  `--task` and `--untask`, refuses. `--delivery` naming the current delivery,
  or `--delivery none` with no delivery set, refuses. A call with none of the
  three flags refuses and names them. A flag that applies only to another
  record, such as `--title`, refuses ("doesn't apply to a decision").
- **One transaction, checked inside.** `confirm`, `overturn`, and `update` each
  read the decision's lifecycle and links inside their own store transaction
  and write in that transaction, so a link racing an overturn either lands
  before it, and is annotated, or refuses as terminal
  ([ADR 0023](0023-concurrency-and-safety-posture.md)).
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

- The decision owns its links: a `decision_task` table of (decision, task)
  pairs, unique per pair. Only decision writes change them: `decide --task`
  and `update KEY-qN --task KEY-N` add a link, and `update KEY-qN --untask
  KEY-N` removes one. No task verb writes a link.
- A link names a task (not a phase or an initiative) in the decision's
  project. The task may have any status, because work already done on the
  answer is exactly what an overturn must reach. `move` keeps a task in its
  project, so a link never crosses projects.
- Links stay writable for as long as the decision is provisional. An agent
  usually decides first and creates the tasks that build on the answer later.
- **Reads, both ways.** `get KEY-qN` carries `tasks`, the linked task ids in
  task-sequence order. A task's `get` carries `decisions`: each linked
  decision's id and lifecycle, in decision-sequence order. The task field is
  derived from the link table and never stored on the task, as a delivery's
  `members` are derived from the tasks that name it. Other task reads (`list`,
  `next`, `status`) do not carry it.

### The delivery link

- `--delivery KEY-dN` names a delivery in the decision's project that is not
  terminal. `update KEY-qN --delivery none` clears the link while the
  decision is provisional.
- The link records which attempt raised the question. It gates nothing: a
  decision can link tasks that are not the delivery's members, and the
  delivery's verbs never read its decisions.
- A decision keeps its delivery link after the delivery ends, as a landed task
  keeps its delivery reference. When an abandoned delivery's work moves to a
  new delivery, the agent repoints each provisional decision with `update`.

### The overturn annotation

- `overturn` annotates every linked task in the same store transaction as the
  lifecycle change. The annotation names the decision and the operator's
  answer:
  - `decision KEY-qN overturned: option N (<option text>)`
  - `decision KEY-qN overturned: option N (<option text>): <note>`
  - `decision KEY-qN overturned: <note>`
- Unlike `triage`, which skips settled tasks
  ([ADR 0020](0020-seeds-grooming-queue-entity.md)), the overturn annotates a
  linked task whatever its status. A `done` task built on an overturned
  answer is the one most in need of redoing.
- Each annotation is an ordinary task annotation, so it stamps the task's
  `updated_at`, as every annotation does. This is accepted: the overturn is
  new information about the task. A stale task stops reading stale, and a
  settled task's project shows recent activity, because the task now has
  something to act on.
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
provisional decision gates no verb. A cap on provisional decisions is a term
of a delivery's agreement text. Mimir stores no cap; the agent applies its cap
from the reads below.

### Reads

- `get KEY-qN` returns the whole record with its links and history.
- A flat `decisions` read lists a project's decisions, provisional by default,
  with filters by lifecycle, class, delivery, and whether the decision has
  work built on it. **Work built on it** means at least one linked task that
  is not `abandoned`.
- **The cap query** is that read, with filters the caller composes, narrowed
  to provisional `product` and `architecture` decisions with work built on
  them, optionally in one delivery. It is not a built-in read, and Mimir gives
  neither class any meaning of its own. A decision with no work built on it does not count, because no
  work is at risk if it is overturned. An agent links a task before building on
  an answer, so the count rises when the risk does.
- The overview counts a project's provisional decisions.
- These reads ship after the record. This ADR fixes their meaning.
- Search does not cover decisions, as it does not cover deliveries.

### The log

- `decision_history` has its own closed kind set: `lifecycle`, `link`, and
  `delivery`. Each row has `from_value`, `to_value`, an optional `reason`, a
  nullable `task` (set only and always on `link` rows), and `at`. Rows read in
  insertion order.
- A `lifecycle` row records `provisional → confirmed` or
  `provisional → overturned`. Its reason is the outcome note. A decision's
  birth is its `created_at` and writes no lifecycle row, as a delivery's
  creation writes none.
- A `link` row is an event, so its `from_value` is always null. Its
  `to_value` is `linked` or `unlinked`, and its `task` names the task.
- A `delivery` row records the delivery link's old and new ids, either of
  which may be null.
- `decide` writes one `link` row per linked task, in task-sequence order, then
  one `delivery` row (null to the delivery) when `--delivery` is given. An
  `update` writes its `unlinked` rows, then its `linked` rows, each in
  task-sequence order, then its `delivery` row.
- Decision writes add no rows to `transition_log`. The overturn annotations
  are ordinary task annotations.

### Archived projects

A decision follows its project's archive state, as a seed and a delivery do
([ADR 0015](0015-project-archive-frozen-and-hidden.md)). Every write to a
decision refuses while its project is archived. `get KEY-qN` resolves
`not_found`, and the `decisions` read refuses the project as not found, as
`deliveries` does.

### Transfer

- The store export carries `decision`, `decision_task`, and
  `decision_history`, and a fifth per-project counter, `last_decision_seq`.
  Its schema version increments. An export of an older version reads as
  having no decisions and a counter of zero.
- Decisions export in project-key, then numeric-sequence order; links in
  decision, then task-sequence order; history in insertion order. Import
  preserves the history's document order and never sorts it by `at`.
- Import writes decisions after nodes and deliveries, then their links and
  history, because a decision names a delivery and a link names a task.
- **Import refuses, and doctor reports,** a decision that breaks any rule the
  verbs keep, including:
  - fewer than two options, a blank question or option, a `why` or
    `outcome_note` stored as blank text, a value outside a closed set, or a
    `recommended`, `taken`, or `overturn_option` outside the options;
  - a delivery that is missing or in another project;
  - a link to a missing record, to a node that is not a task, or to a task in
    another project, or the same pair linked twice;
  - a `link` history row with no task, or another kind of row that names one;
  - an `overturn_option` or `outcome_note` on a provisional decision, an
    `overturn_option` on a confirmed one, an `overturn_option` equal to
    `taken`, or an overturned decision with neither an option nor a note;
  - a provisional decision with any `lifecycle` row, a terminal decision
    without exactly one `lifecycle` row to its lifecycle, a row whose reason
    differs from `outcome_note`, or a sequence above its project's counter.

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
- **`decide` is its own creation verb.** ADR 0024 gives a record its own
  creation verb when its creation ergonomics are the feature. An agent records
  a decision mid-task, many times a delivery, in the words of the claim it
  makes; the verb is that claim, and it pairs with `confirm` and `overturn`.
  `create decision` would read as planning a record, not as taking an answer.
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
- **`create decision`.** See *`decide` is its own creation verb*.
- **Counting every provisional decision toward the cap.** A decision no work
  rests on risks no rework, and counting it would stop a delivery that has
  nothing to redo.

## Consequences

- The id grammar gains `KEY-qN` beside `KEY-aN`, `KEY-sN`, and `KEY-dN`
  ([ADR 0006](0006-human-readable-node-ids.md)), with the same numeric
  sequence parsing, so `MMR-q04` names `MMR-q4`. Project keys are uppercase,
  so a `q` id never collides with `KEY-seq`.
- Both stores gain the `decision`, `decision_task`, and `decision_history`
  tables, and `project` gains `last_decision_seq`.
- The CLI and MCP gain `decide`, `confirm`, and `overturn`, plus `get` and
  `update` on a `KEY-qN` id. A task's `get` gains `decisions`. ADR 0024 gains
  an amendment for `decide`. The contract snapshot and the version window
  change with them
  ([ADR 0038](0038-device-pairing-and-the-version-window.md)).
- The console's review page already names its groups of tasks that need the
  operator `decisions`. Those are tasks, not decision records. The delivery
  page, which shows decision records in the needs-you set, settles how the
  two read side by side.
- A project that never records a decision behaves exactly as before.

## Refinement (2026-11-18, MMR-705): an option's detail

An option's text is short so that it reads as an answer, in a radio row, a
chip, or an overturn annotation. Some answers cannot be understood from
their text alone. An agent may give any option a **detail**: a sentence or
two of context the operator reads before answering. Most options carry
none.

### The record

| Field            | Shape                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `option_details` | A list as long as `options`: entry N is option N's detail, or null when it has none. Stored on the decision row as a JSON array, or null when no option has a detail |

- Every read returns `option_details` as a list as long as `options`, so a
  reader pairs an option with its detail by position. A decision with no
  details reads as a list of nulls. A null column, a list of nulls, and a
  missing field all read the same.
- A detail is non-blank text, stored as given. It has no length limit, as no
  decision text has one. The skill steers its length.
- The detail is fixed at `decide`, as the options are.
- The field is additive. `options` keeps its shape, so a client older than
  this refinement keeps working inside the version window and ignores the
  field ([ADR 0038](0038-device-pairing-and-the-version-window.md)).
  `MIN_CLIENT` does not rise.

### `decide`

```sh
mimir decide "Store snapshots per task or per phase?" \
  --option "Per task" --option "Per phase" \
  --detail "2: Phase is the review unit in ADR 0042, so one snapshot covers a review." \
  --recommend 2 --class architecture
```

- `--detail "N: text"` repeats. N is an option number, then a colon, then
  the detail. The space after the colon is optional, and the detail is the
  text after it as given.
- `decide` refuses, and names the fix, when a value has no `N:` prefix, N is
  not an option, N appears twice, or the text after the prefix is blank.
- The Engine's `decide` takes `option_details` as an optional list as long
  as `options`, each entry a non-blank text or null. It refuses a list of
  another length or a blank entry. The CLI and MCP turn their `--detail`
  values into that list. MCP takes the CLI's `detail` values, as every
  command's tool takes its flags.

### Reads

- `get KEY-qN` and the `decisions` read carry `option_details` in JSON.
- In text, a detail prints indented under its option in the _Options_ block,
  with the same hanging indent as the option's text.
- The overturn annotation keeps its form and names the option's text only.

### Transfer

- The store export carries `option_details` on each decision row, and its
  schema version increments. An export of an older version reads every
  decision as having no details.
- **Import refuses, and doctor reports,** an `option_details` whose length
  differs from `options`, or an entry that is blank text or not text.

### The console

The decisions walkthrough shows a detail under its option's text ([ADR 0019](0019-meridian-console-design-system.md),
MMR-705 refinement). Decision rows, chips, the walkthrough's rail, and its
check step show no details.

### Why

- **A list beside `options`, not options as objects.** Objects read more
  cleanly, but changing `options` breaks every older client that renders a
  decision. A parallel list is additive, and the read always fills it, so no
  reader has to guess at a missing or short list.
- **`N:` names the option.** Options are already named by number, as
  `overturn --option N` does. A detail paired by position would need a
  placeholder for each option without one, and a miscount would move a
  detail to the wrong option without any error.
- **No length limit.** No other decision text has one. The walkthrough
  clamps a long detail, and the skill asks for a sentence or two.
