---
name: mimir
description: Drives Mimir, the work-state store for tasks, their hierarchy, statuses, seeds, artifacts, and scratchpads, through the `mimir` CLI. Use when a request names a Mimir id such as `MMR-12` or `MMR-s3`, or when work reads or changes the board - tracking tasks, checking the queue, setting up a project, or keeping a scratchpad.
---

# Mimir

Mimir holds a project's work state: the task board, the project → initiative →
phase → task hierarchy, statuses, seeds, and frozen artifacts. The board is the
record that outlives a conversation. You drive it with the `mimir` CLI. Every
example in this skill is a real invocation.

This skill describes how Mimir works: its records, what each status and verb
means, and the exact command surface. When to consult the board, which work to
take, and how a session routes and finishes its work belong to the user and the
project's own process.

## Reading the board

1. `command -v mimir` finds the binary. When it is missing, Mimir is not
   installed (`references/setup.md`).
2. `mimir bind` prints the project this clone is bound to, which is the default
   scope. A clone with no binding binds itself when its `origin` matches exactly
   one project's remote. A non-zero exit means the repo is not tracked; setting
   up tracking is the user's call (`references/setup.md`).
3. `mimir overview` shows a bound project's rollup, direction, in-flight work,
   active Scratchpads, the ready queue, recent sessions, and hygiene
   (`references/querying.md`). An overview is a snapshot of the board when it
   ran. An active Scratchpad is a live episode's memory
   (`references/scratchpad.md`).
4. `mimir triage` reports a board's untriaged seeds and seeds ready to resolve,
   and annotates the board's unsettled tasks whose upstream seed went terminal
   (resolved or rejected). It changes no status and is safe to repeat
   (`references/seeds.md`).

## Statuses and verbs

Statuses move only through verbs: `queue`, `unqueue`, `start`, `submit`,
`return`, `done`, `abandon`, `reopen`, `park`/`unpark`, and `block`/`unblock`.
`update` patches fields and leaves status alone. Seeds move through `promote`,
`reject`, `resolve`, and `park`/`unpark`.

Each transition records a claim and its time. Run it at the moment the claim
becomes true: a transition recorded later is a guess about the past that the
next reader takes as fact.

- `queue <id> --harness <h> --session <s>` reserves a task for a run (`todo →
  queued`) and keeps it out of `next`. `unqueue <id> "reason"` releases the
  reservation before a worker starts.
- `start <id>` claims the work has begun (`todo` or `queued` → `in_progress`).
  A session may hold any number of `in_progress` tasks; each carries its own
  handles.
- `submit <id>` claims the work is ready for its review gate (`in_progress →
  under_review`). The task leaves `next` and keeps its handles, and work done
  in response to that review needs no status change. `return <id> "what to
  change"` sends it back to `in_progress`.
- `done <id>` claims the work is complete and verified. A project that gates
  completion, for example on merge, holds the task in `under_review` until the
  gate clears.
- `block <id> "reason"` records an external obstruction and `park <id>
  "reason"` a deliberate deferral; `unblock` and `unpark` lift them. The reason
  is the next reader's context. `block --on you|others` names who can clear
  it: `you` when the operator must act, `others` when someone outside the
  board must. Without `--on`, a task with an `upstream` seed is `others` and
  any other task is `you`. To change an owner, `unblock` and `block` again.
- `abandon <id> "reason"` ends a task that will not be done; it stays on the
  record with its reason. `reopen <id> "reason"` corrects a terminal call that
  was wrong, such as a `done` that verification later falsified.
- `annotate <id> "note"` appends a decision, a surprise, or a scope change to
  a task's notes.

`references/status-model.md` defines every status word, rollup, and the
derived `ready`, `awaiting`, and `stale` states.

## Task owners

`--harness` and `--session` identify the main user conversation or workflow
that holds a task. `--worker-session`, with `--worker-harness` when known,
identifies a distinct agent that owns the whole task lifecycle; a main agent
working its own task leaves the worker fields unset. A helper handling a piece
of a task does not change its identity. Shell auto-fill can supply main
identity on `queue` or an initial `start`; worker identity, `update`, and MCP
calls take explicit values. `references/authoring.md` covers finding a
session id and recording a handoff.

Holds (`park`, `block`), terminal verbs, and `unqueue` clear every handle and
keep the former owners in history; `submit` and `return` keep them. To find
what a session holds:

```sh
mimir list --status in_progress --eq session:<main-session> --missing worker_session
mimir list --status in_progress --eq worker_session:<worker-session>
mimir list --status under_review --eq session:<main-session>
mimir list --status queued --eq session:<main-session>
```

A queued task must be unqueued before `park` or `block`.

## Grooming state

A task carries a grooming state beside its status: `not_groomed`,
`needs_answers`, or `groomed`. It gates nothing. `mimir groom <id> <state>
"note"` sets it, and `needs_answers` requires a note naming the open
questions. `mimir next --eq grooming:groomed` narrows the ready queue to
groomed work. A question that stops a started task is recorded with `block`
(`references/authoring.md`).

## Tasks and seeds

A **task** is committed work in the tree (`create task`, plus `depend` when it
gates other work). A **seed** is a record on a board's grooming queue that
commits to no work; the owning board's triage promotes it into tasks, resolves
it, rejects it, or parks it.

A seed is how one board asks another for work: `mimir seed "title" -k <kind>
-p KEY` files it on the other board and records the bound board as the requester.
When a task waits on that seed, `mimir update <id> --upstream KEY-sN` records
the edge, and a later `block` defaults to `others`; triage annotates the task
when the seed settles. `references/seeds.md` covers filing, triage, and
`upstream`.

## Finishing records

Three records describe a finished piece of work, and each stands alone: the
task's transition, a container's `## Next` direction (groom-next, distinct
from the `groom` verb), and a `session_summary` artifact.
`references/finishing.md` covers how to write each one.

## Ids and commands

- Ids share one grammar: a project is `KEY` (`MMR`); a task, phase, or
  initiative is `KEY-seq` (`MMR-16`); an artifact is `KEY-a3`; a seed is
  `KEY-s3`. A Scratchpad is a UUID that only the `scratch` subcommands take.
- Work-state verbs are flat (`mimir done MMR-16`, `mimir resolve MMR-s3 <reason>`).
  Scratchpad operations group under `mimir scratch`, and installation commands
  (`store`, `skills`) group under their noun. `self-update` replaces the binary.
- Every create and mutation echoes the affected id. Capture it and compose with
  it: `ID=$(mimir create task "…" --parent MMR-2 -f ids)`. Sequence numbers are
  never reused, so a guessed id writes to the wrong row.
- Inside a bound repo, commands default to the bound project. `-s KEY` targets
  another project; a board read names exactly one project, and there is no
  `-s all`. `mimir projects` lists the active project keys whatever the
  binding; `--status all` adds the archived ones, and a loop over its keys is
  the cross-project sweep.
- `mimir get <id>` reads any record by id.
- Use the verbs and flags the references show. The surface is exact, and a
  guessed flag can write the wrong field without an error. Before your first
  create, update, or restructure, open the matching reference below. `mimir <cmd> --help` reminds you of a verb's flags; the reference
  teaches the workflow around it.
  Renamed verbs keep no alias; the unknown-command error names the replacement
  when there is one.

## Routing

Read the matching reference before you act in its area.

| You need to…                                                            | Read                         |
| ----------------------------------------------------------------------- | ---------------------------- |
| Set up tracking: install, bind, create a project, backfill history      | `references/setup.md`        |
| Add or restructure work: tasks, phases, deps, artifacts, annotations    | `references/authoring.md`    |
| Ask the board questions: queues, triage, drill-down, reports, scripting | `references/querying.md`     |
| Keep an unsettled episode across compaction: Journal, Agenda, freeze    | `references/scratchpad.md`   |
| Record finished work: transition, groom-next, summarize                 | `references/finishing.md`    |
| Understand a status word, group, or rollup                              | `references/status-model.md` |
| Classify with tags                                                      | `references/tags.md`         |
| File or triage grooming-queue records: ideas, bugs, cross-board asks    | `references/seeds.md`        |

A host that cannot run shell commands but has the Mimir MCP server configured
uses the same verbs as tools. A tool is named for its command path joined with
`_` (`create_task`, `scratch_checkpoint`), and its inputs are the command's
arguments and options by their declared names (`worker-session`, `at-or-before`).
A board read takes its project from `scope` or from the clone the server started
in (`seeds` also takes `project`, which wins); there is no `all`.
