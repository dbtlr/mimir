---
name: mimir
description: Drive Mimir — the work-state source of truth (tasks, hierarchy, statuses, artifacts) — via the `mimir` CLI. Load at the START of every session in a repo containing a .mimir.toml (or when the user asks to track work, check the task queue, set up a project, or mentions task/work state). Teaches orientation, task authoring, status transitions, and the query surface.
---

# Mimir: the work-state source of truth

Mimir holds **work state** — the task board, the project → initiative → phase → task
hierarchy, statuses, and frozen artifacts — in a queryable store. The chat scroll is
not the record; the board is. You read it and you keep it true, through the `mimir`
CLI (drive it with shell commands; every example here is a real invocation).

<EXTREMELY-IMPORTANT>
If there is even a **1% chance** a session is starting in a Mimir-tracked repo, run
the gate below BEFORE other work. These thoughts mean STOP — you are rationalizing:

| Thought                                       | Reality                                               |
| --------------------------------------------- | ----------------------------------------------------- |
| "This is just a quick question"               | Orientation costs one command. Run the gate.          |
| "I'll check the board when I start real work" | Work that isn't on the board gets lost. Board first.  |
| "I remember the state from last time"         | State moved. The store is the truth, not your memory. |

</EXTREMELY-IMPORTANT>

## The gate (run first, exit quietly if it fails)

1. `command -v mimir` — missing → not installed; only raise it if the user wants
   work tracking (install: see `references/setup.md`).
2. Is there a `.mimir.toml` here (this directory or any ancestor)? It binds the repo
   to its project and becomes the default scope.
   - **Bound** → orient now: `mimir status <KEY>` then `mimir list` then `mimir next`
     (that order — see `references/querying.md`). On a board you own, follow with
     `mimir triage` — untriaged seeds and ready-to-resolve flags are part of "what
     needs attention" (idempotent, safe every session; `references/seeds.md`).
   - **Not bound** → this repo isn't Mimir-tracked. **Exit quietly and proceed
     normally.** Route to `references/setup.md` only if the user explicitly wants
     this project tracked.

## Non-negotiables

These hold for every Mimir interaction. The references add detail; nothing in them
relaxes these.

**1. Statuses move only through verbs.** `start` · `submit` · `return` · `done` ·
`abandon` · `park`/`unpark` · `block`/`unblock`. There is no editable status field, and
`update` cannot touch status — that is by design, not an omission. Seeds
(grooming-queue records) move through their own verbs — `promote` · `reject` ·
`resolve` (`references/seeds.md`).

**2. The transition contract — transition at the moment, not later:**

- `start <id>` **when you choose the task, before the first edit.** Any touch counts;
  no retroactive starts. Keep one task `in_progress` per working session.
- `done <id>` **only after verification, and before telling the user it's finished.**
  About to report completion? If you haven't run `done`, stop and run it.
- `submit <id>` **when the work is shippable but wants a human review first** (the
  optional `under_review` gate). Use it instead of `done` when a human must sign off
  before it counts as finished; the reviewer then `done`s it (approve) or
  `return <id> "what to change"`s it (back to `in_progress` for you to pick up).
  Skip it and go straight to `done` when no review is wanted.
- `block <id> "reason"` / `park <id> "reason"` **the moment you stall** — external
  obstruction → block; deliberate deferral → park. Always give the reason; it is the
  next agent's context. `unblock`/`unpark` on resume.
- `abandon <id> "reason"` when an approach or task dies. Never delete, never leave a
  zombie `todo`.
- **Discovered work = a new task** (`create task` + `depend` if it gates something),
  never a silent widening of the current one. `annotate` the current task with what
  you found.
- **Discovered _non-work_ = a seed.** A bug you noticed, an idea, a capability ask —
  especially against **another** board — implies no committed work, only triage:
  `mimir seed "…" -k <kind> [-p KEY]`, never a prose note that decays. If it blocks
  you: `block` your task **and** set `--upstream KEY-sN` — never a prose-only hold
  (`references/seeds.md`).
- `annotate <id> "note"` when something lands mid-flight — a decision, a surprise, a
  scope change.
- **The end-of-session sweep (the catch-all):** before ending, run
  `mimir list --status in_progress` and reconcile every row you touched — finish it
  (`done`), hand it forward honestly (`annotate` + leave), or shelve it
  (`park`/`block`/`abandon`).

| Rationalization                     | Reality                                          |
| ----------------------------------- | ------------------------------------------------ |
| "I'll update statuses at the end"   | The end never comes. Transition at the moment.   |
| "This was just a tiny fix"          | Tiny fixes are work. Track it or don't touch it. |
| "I don't want to clutter the board" | An untracked in-flight task IS the clutter.      |
| "The user saw me do it"             | Mimir is the record, not the chat scroll.        |

**3. Ids: one grammar.** Project = bare `KEY` (e.g. `MMR`) · work node = `KEY-seq`
(`MMR-16`) · artifact = `KEY-a3` · seed = `KEY-s3`. Any id slot takes the full
grammar; a verb rejects what it can't act on.

**4. Compose with the echoed id — never guess the next number.** Every create/mutation
echoes the affected id. Capture it (`ID=$(mimir create task "…" --parent MMR-2 -f ids)`);
sequence numbers are never reused, so a guessed id hits the wrong row silently.

**5. The controller owns the board.** Reads are free for any agent. Mutation verbs
belong to whoever owns verification: if you were dispatched as a subagent, transition
only when your dispatch prompt explicitly delegates it — otherwise report back and let
the controller transition. A solo agent is its own controller; the full contract applies.

**6. Scope is ambient.** Inside a bound repo, plain `mimir next` / `mimir list` are
already scoped to the bound project. `-s KEY` targets another project; `-s all`
queries every project.

## Routing

| You need to…                                                            | Read                         |
| ----------------------------------------------------------------------- | ---------------------------- |
| Set up tracking: install, bind, create a project, backfill history      | `references/setup.md`        |
| Add or restructure work: tasks, phases, deps, artifacts, annotations    | `references/authoring.md`    |
| Ask the board questions: queues, triage, drill-down, reports, scripting | `references/querying.md`     |
| Understand a status word, group, or rollup                              | `references/status-model.md` |
| Classify with tags                                                      | `references/tags.md`         |
| File or triage grooming-queue records: ideas, bugs, cross-board asks    | `references/seeds.md`        |

(If your host can't shell out but has the Mimir MCP server configured, the verbs map
1:1 — same names, same arguments, same binding-derived default scope.)
