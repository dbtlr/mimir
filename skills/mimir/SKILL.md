---
name: mimir
description: Drives Mimir, the work-state store for tasks, their hierarchy, statuses, artifacts, and scratchpads, through the `mimir` CLI. Use at the start of every session in a repo with a `.mimir.toml`, when a request names a Mimir task id such as `MMR-12`, and when the user asks to track work, check the task queue, set up a project, or keep a scratchpad.
---

# Mimir

Mimir holds a project's work state: the task board, the project → initiative →
phase → task hierarchy, statuses, and frozen artifacts. The board is the record
that outlives this conversation, so read it before you plan and keep it true as
you work. You drive it with the `mimir` CLI. Every example in this skill is a
real invocation.

## Orient first

The board changes between sessions. An agent that plans from memory redoes or
contradicts work already in flight, and orientation costs one command, so
orient before other work, quick questions included:

1. Run `command -v mimir`. If it is missing, Mimir is not installed. Mention
   that only when the user wants work tracking (`references/setup.md`).
2. Look for `.mimir.toml` in this directory or an ancestor. It binds the repo
   to its project and sets the default scope.
   - **Unbound:** this repo is not tracked. Carry on with the user's request
     without Mimir, and set it up only when the user asks (`references/setup.md`).
   - **Bound:** orient from `mimir overview`. It shows the project rollup,
     direction, in-flight work, active Scratchpads, the ready queue, recent
     sessions, and hygiene (`references/querying.md`). If the session's
     opening context (a session primer) already includes `mimir overview` for
     this project, reuse it and do not run the command again. Read any active
     Scratchpad before planning: it is a live episode's memory and may already
     cover the work in front of you (`references/scratchpad.md`). On a board
     you own, follow with `mimir triage`. It reports untriaged seeds and seeds
     ready to resolve, annotates your tasks whose upstream seeds resolved, and
     is safe to repeat (`references/seeds.md`).

## The working contract

These rules hold unless the user or the project's own instructions say
otherwise. The references add detail and never relax them.

**Statuses move through verbs.** `start`, `submit`, `return`, `done`,
`abandon`, `reopen`, `park`/`unpark`, and `block`/`unblock` are the only way to
change a task's status. `update` patches fields and leaves status alone. Seeds
move through `promote`, `reject`, and `resolve`.

**Transition at the moment the claim becomes true.** A transition recorded
later is a guess about the past, and the next agent reads it as fact.

- `start <id>` when you choose a task, before the first edit. Every change,
  however small, belongs to a task. Keep one task `in_progress` per session.
- `done <id>` after verification and before you tell the user the work is
  finished. Verification is evidence that the change does what the task
  asked: a test that exercises it passes, or you ran the behavior and observed
  it. For a change with no runtime behavior, read the result back. When the
  project has its own completion gate (for example, done only after merge),
  follow it and use `submit` until the gate clears.
- `submit <id>` in place of `done` when a human must review the work before it
  counts as finished. The reviewer runs `done` to approve, or
  `return <id> "what to change"` to send it back to you.
- `block <id> "reason"` when something external stops you, and
  `park <id> "reason"` when you defer the task on purpose. The reason is the
  next agent's context. `unblock` or `unpark` when you resume.
- `abandon <id> "reason"` when a task or an approach dies. Abandoned tasks stay
  on the record with their reason.
- `reopen <id> "reason"` when a terminal call was wrong: a `done` that later
  verification falsified, or an abandoned approach that is back on. More work
  found after a genuine `done` is a new task.
- `annotate <id> "note"` when a decision, a surprise, or a scope change lands
  mid-task.

**Route new work by whose board it is** (`references/seeds.md`):

- Work for **your own board** that you find or defer is a new task, not an
  expansion of the current one: `create task`, plus `depend` when it gates
  something. `annotate` the current task with the finding. This holds when the
  fix, or a decision inside it, is still open; put the open question in the
  task description. Review findings and test follow-ups end as fixed,
  dismissed with a reason, or a deferred task.
- Anything for **another board** is a seed on that board, however well you
  can state the fix: `mimir seed "title" -k <kind> -p KEY`. The owning board
  decides what work to commit, so you create tasks only on boards you own.
  When that seed blocks your task, `block` the task and record the edge with
  `mimir update <id> --upstream KEY-sN`, so triage can tell you when it resolves.
- An own-board idea that is not a follow-up of your current task and has no
  statable fix ("should we…?") is a seed too. Work you set aside to keep the
  current task in scope is a task, even when the user says "park that".

**Sweep before the session ends.** Run `mimir list --status in_progress` and
settle every task you touched: finish it, hand it forward with an `annotate`,
or `park`, `block`, or `abandon` it. Settle the Scratchpads you drove the same
way: freeze, checkpoint, or discard.

**Finish in three pieces.** A work boundary may need a transition, a
groom-next of the `## Next` direction, or a session summary. Completing a task
takes all three, in that order. Run each when its trigger fires, rather than
saving them for the end: transition when state changes, groom-next when the
board's direction changes, and summarize while the session is fresh. Read
`references/finishing.md` before running any of them.

**Report board changes with the outcome.** Tell the user what moved on the
board in the sentence that reports the work ("Fixed the typo; QEV-2 is done."),
rather than narrating each command.

**User and project instructions take precedence.** When the user asks you to
skip tracking for a change, skip it and say that the change went untracked.

**The controller owns the board.** Any agent may read it. If you were
dispatched as a subagent, run mutation verbs (status changes, creates,
updates, annotations, seeds) only when your dispatch prompt delegates them;
otherwise report back and let the controller act. A solo agent is its own
controller.

## Ids and commands

- Ids share one grammar: a project is `KEY` (`MMR`); a task, phase, or
  initiative is `KEY-seq` (`MMR-16`); an artifact is `KEY-a3`; a seed is
  `KEY-s3`. A Scratchpad is a UUID that only the `scratch` subcommands take.
- Work-state verbs are flat (`mimir done MMR-16`, `mimir resolve MMR-s3`).
  Scratchpad operations group under `mimir scratch`, and installation commands
  (`service`, `store`, `skill`) group under their noun.
- Every create and mutation echoes the affected id. Capture it and compose with
  it: `ID=$(mimir create task "…" --parent MMR-2 -f ids)`. Sequence numbers are
  never reused, so a guessed id writes to the wrong row.
- Inside a bound repo, commands default to the bound project. `-s KEY` targets
  another project, and `-s all` spans every project. `mimir projects` lists
  the active project keys whatever the binding; `--status all` adds the
  archived ones.
- `mimir get <id>` reads any record by id.
- Use the verbs and flags the references show. The surface is exact, and a
  guessed flag can write the wrong field without an error. Before your first
  create, update, or restructure in a session, open the matching reference
  below. `mimir <cmd> --help` reminds you of a verb's flags; the reference
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
| Finish a task or session: transition, groom-next, summarize             | `references/finishing.md`    |
| Understand a status word, group, or rollup                              | `references/status-model.md` |
| Classify with tags                                                      | `references/tags.md`         |
| File or triage grooming-queue records: ideas, bugs, cross-board asks    | `references/seeds.md`        |

A host that cannot run shell commands but has the Mimir MCP server configured
uses the same verbs as tools, with the same names, arguments, and default scope.
