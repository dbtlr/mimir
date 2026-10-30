# Authoring: create, structure, record

Contents: [Creating work](#creating-work) · [A task vs. a step](#a-task-vs-a-step) ·
[Grooming tasks](#grooming-tasks) ·
[Dependencies and structure](#dependencies-and-structure) ·
[Patching vs annotating](#patching-vs-annotating) ·
[The direction narrative](#the-direction-narrative--next) ·
[Resume handles](#resume-handles-how-the-work-is-picked-back-up) ·
[Artifacts](#artifacts-frozen-records) · [Tagging](#tagging)

## Creating work

```sh
mimir create initiative "Goal-level body of work" --parent KEY [--desc "…"] [--tag t]...
mimir create phase "A testable increment / baseline" --parent KEY-3 [--target "v1.0"]
mimir create task "A discrete, verifiable outcome" --parent KEY-4 \
    [--priority p0..p3] [--size small|medium|large] [--desc "…"] [--ref JIRA-123] [--groomed] [--tag t]...
```

- An initiative's parent is the bare project `KEY`; phases parent to initiatives;
  tasks parent to phases **or directly to initiatives** (skip levels the work
  doesn't need).
- `priority`/`size` are optional **signals** — they filter and advise; they never
  reorder the queue. Leave them off rather than guessing.
- `--groomed` creates a task already `groomed`, for tasks carved from a finished
  design. Without it a task starts `not_groomed`. It applies to tasks only.
- A title that begins with a dash needs the `--` terminator so it isn't read as
  a flag: flags first, then `-- <title>` —
  `mimir create task --parent KEY-4 -- "--flag-name is misparsed"`.
- `create <type>` creates every tree node. Seeds (`mimir seed`,
  `references/seeds.md`) and artifacts (`mimir attach`, below) have their own verbs.

## A task vs. a step

A task **finishes something**: it names a verifiable definition-of-done and is
bounded two ways — never so large that whether it's _done_ is unknowable, never so
small that finishing it finishes nothing. Sizing is **not** a session, a time-box,
or a commit/PR (all arbitrary). Below a task are **steps** — a checklist toward its
done-state; steps are the executor's own todo list or `annotate` notes, **never
child tasks** (the tree has no sub-task level).

Before `create task`, check — any "no" means it's a step, not a node:

1. **Finishes something** — when done, is a discrete, observable thing complete, not
   just a layer touched? ("Add the migration" finishes nothing; "users can sign up,
   behind passing tests" does.)
2. **Knowable done** — can you state its done-state in one sentence two people would
   agree on? Too big to answer → it's a phase; split it.
3. **Stands alone** — reorderable or deferrable without dragging a sibling? Only
   makes sense as "step N toward one outcome" → it's a step.

## Grooming tasks

```sh
mimir groom KEY-9 groomed                          # understood well enough to run
mimir groom KEY-9,KEY-10 groomed "scoped in KEY-3's design"
mimir groom KEY-11 needs_answers "which store owns the lock? is v1 data migrated?"
mimir groom KEY-11 not_groomed                     # back to the default
```

- Grooming state is a judgment you make, never inferred from the description.
  Set `groomed` when a reader could start the task without asking anything.
  Set `needs_answers` when grooming finds gaps; the note is required and names
  the open questions.
- Ids come first, space- or comma-separated, up to the state word. Everything
  after the state is the note, written as an ordinary annotation on every listed
  task. Add a note to `groomed` or `not_groomed` when the reasoning helps the
  next reader.
- `update` never touches the state, and editing a description never resets it.
  When you rewrite a groomed task enough to change what it asks, re-groom it.
- The state gates nothing: `start` never checks it. A task that hits a question
  after you started it is blocked with `block --on you`, not moved back to
  `needs_answers`.
- This is not `groom-next` (the `## Next` direction rewrite in
  `references/finishing.md`) and not the seeds grooming queue
  (`references/seeds.md`), which triages requests that are not yet work.

## Dependencies and structure

```sh
mimir depend KEY-9 --on KEY-7,KEY-8    # KEY-9 waits on both
mimir undepend KEY-9 --on KEY-8
mimir move KEY-9 --to KEY-5            # re-parent
mimir reorder KEY-9 --top | --bottom | --before KEY-7 | --after KEY-7
```

- A dependency is satisfied when its prerequisite is **terminal** (`done` or
  `abandoned`) — abandoning a prerequisite never strands its dependents.
- `depend` records edges. To mark a task manually stuck on something external, use
  `block` (a hold) — they are different things (see `references/status-model.md`).
- `reorder` is the master "what's next" order (rank). It beats priority — placing a
  p2 above a p0 is legitimate and deliberate. Rank is relative only: you say
  before/after/top/bottom, never a number.
- Rank belongs to **tasks only**, and it is one flat order across the whole
  project: `--before`/`--after` take any ranked task in the project, not just a
  sibling under the same phase. Phases and initiatives carry no rank, and
  `reorder` on one is refused.

### Sequencing phases

To make one phase follow another, depend the containers, not their tasks:

```sh
mimir depend KEY-12 --on KEY-11    # phase 2 waits on phase 1
```

Dependencies are inherited down the tree, so every task under phase 2 is held
out of `next` until phase 1 settles (`done` or `abandoned`). Reorder still ranks
every unheld todo or in-progress task, including those awaiting a phase
dependency, so you can pre-rank phase 2 now; `next` just skips them until
phase 1 settles. Reorder never orders phases themselves.

## Patching vs annotating

```sh
mimir update KEY-9 --title "…" --desc "…" --priority p1 --size small --ref X --target Y
mimir annotate KEY-9 "Realized the parser must be rewritten; filed KEY-12."
```

- `update` patches scalar **fields**; it cannot touch status (verbs only).
- `update KEY-aN --title "…" --summary "…"` patches an artifact — title and
  summary are its two mutable fields (content is frozen; attach a new artifact
  to correct one).
- `update KEY --pinned` pins a project (`--not-pinned` unpins it); the console
  lists pinned projects first. Only a project takes it — a task, container,
  seed, or artifact refuses the flag. The `update` tool takes `pinned: true`
  to pin, and `pinned: false` or `not-pinned: true` to unpin.
- `update KEY --remote <url>` sets a project's Git remote, stored normalized so
  ssh and https forms compare equal; a blank value clears it. `create project
  --remote` sets it at creation. Only a project takes it. The `update` and
  `create_project` tools take `remote`.
- Re-tagging is idempotent — an existing tag is kept as-is. A tag application
  carries no note; put one-off rationale in `annotate` instead.
- `annotate` appends a timestamped freeform note — the in-flight record of
  decisions, surprises, scope changes. Annotations are append-only and permanent:
  misdirected one? Append a correction note; nothing is edited or deleted.
- Transition _reasons_ belong on the transition itself
  (`park <id> "reason"`), not in annotations.

## The direction narrative (`## Next`)

```sh
mimir update KEY --direction "Read path first; caching waits on the benchmark."
mimir update KEY-4 --direction ""      # clear it
```

- Projects, initiatives, and phases carry an owned `## Next` body section — the
  editorial statement of **where this container is headed**. Tasks don't: their
  prose homes are `--desc` and annotations.
- Write only what Mimir cannot derive. The queue itself (what's ready, what's
  ranked first, what's blocked) is already answered by `mimir next` / `overview`;
  restating it here is a rollup that will drift. Direction is the judgment
  _above_ that: sequencing rationale, what is deliberately deferred, the bet
  being made.
- **Replace, not append.** Each write re-authors the whole section against the
  current board; there is no append mode, and a blank value clears the section.
  Read it, decide what is still true, and write the new whole.
- The write is CAS-guarded like every other. If a concurrent write landed first,
  it refuses: **re-read and merge** against the current text, then write again.
- Re-writing identical text writes nothing, so an idempotent re-author doesn't
  move `updated_at` (and doesn't fake activity).
- **Guard a scripted write.** Mimir keeps no earlier version, so a command
  substitution that reads a missing or empty file clears the narrative. In a
  fresh temporary directory, save the current text, write the new text to a
  file, and update only when that text is not empty. Read the result back and
  compare it before you delete the directory; if it is wrong, restore with
  `--direction "$(cat "$dir/old.md")"`.

  ```sh
  dir=$(mktemp -d)
  mimir get KEY-4 -f json | jq -r '.next // empty' > "$dir/old.md"
  # Write the new narrative to "$dir/new.md", then:
  new=$(cat "$dir/new.md") && test -n "$new" &&
    mimir update KEY-4 --direction "$new" &&
    mimir get KEY-4 -f json | jq -r '.next // empty' | diff "$dir/new.md" - &&
    rm -r "$dir"
  ```

- The flag is `--direction`, not `--next` (`self-update` selects a channel with `--channel next`).
  The `update` tool takes `direction` too. Reads name it `next`: `--col next`
  and the `next` key of `get -f json`. `overview -f json` carries it under
  `direction`, because its own `next` key is the ready queue.
- It is an `update` flag only — set the narrative after the container exists;
  `create --direction` is refused rather than silently dropped.

## Resume handles: how the work is picked back up

`harness` and `session` identify the main user conversation or workflow that
owns the task's context. `worker_harness` and `worker_session` identify an
optional distinct agent responsible for the **whole task lifecycle**, including
verification and disposition. A helper that implements a piece or reviews work
does not become the task owner. When the main agent owns the task itself,
leave both worker fields unset.

```sh
mimir queue KEY-9 --harness codex --session "$MAIN_SESSION"
# Main agent starts its own task; main identity stays established.
mimir start KEY-9 --harness codex --session "$MAIN_SESSION" --branch feat/key-9
# Alternative: a distinct whole-task owner starts the queued task.
mimir start KEY-9 --worker-harness claude --worker-session "$WORKER_SESSION" --branch feat/key-9
# A new distinct owner takes over an already-started task.
mimir update KEY-9 --worker-harness claude --worker-session "$NEW_WORKER_SESSION"
mimir update KEY-9 --worker-session ''   # return ownership to the main agent
```

Always supply the relevant identity explicitly on every queue and start:
main flags for the user conversation, `--worker-session` for a distinct task
owner, and `--worker-harness` when known.
Use each harness's own knowledge of its resumable session. Inherited shell
variables can describe an outer harness; they do not override that knowledge.

| Harness | Session id in its tool shell |
| --- | --- |
| Claude Code (`claude`) | `CLAUDE_CODE_SESSION_ID` (`CLAUDECODE=1` identifies the harness) |
| Codex (`codex`) | `CODEX_THREAD_ID` |
| opencode (`opencode`) | `OPENCODE_SESSION_ID` (`OPENCODE=1` identifies the harness) |

If an identity cannot be established, resolve it before recording ownership;
a made-up session cannot resume the work. For a new direct start, set the main
identity too before attaching a distinct worker.

The CLI can fill omitted main flags for `queue` from one unambiguous shell.
For `start`, it does so only with no established main identity and no worker
flags. A start preserves an established main identity; conflicting main flags
are refused, so a handoff uses `--worker-session` and optionally
`--worker-harness`. A worker session without a harness leaves the harness
unknown; the CLI never borrows it from the invoking shell. Explicit blanks win.
The shell fills a missing main flag only when every main flag you pass, blanks
included, equals its own value: `--harness codex` in a Claude shell records no
session, and `--session ""` records no harness.
Supplying a worker session without a worker harness also clears any previous
worker harness during a takeover; omitting both fields preserves the assignment.
Multiple detected harnesses produce a note only when main fallback applies.
`update` and MCP never infer identity from their environment.

`queue` records the main reservation. Starting queued work preserves its main
identity and any worker assignment already made with `update`. It resets only
old host and branch fields before applying supplied execution fields. Explicit
worker flags change the worker assignment; a blank worker session clears it.
A worker using the same session as main collapses to unset unless the supplied
harnesses explicitly distinguish two agents. `unqueue` clears all live handles
and retains the released identity in history.

`host` and `branch` locate execution. `update` explicitly changes main or worker
identity without changing status. A worker harness requires a worker session;
a worker session requires a main session. Clearing the worker session clears
its harness. Clear worker ownership before clearing a main session.

`done`, `abandon`, `park`, and `block` clear all six handles. `submit` and
`return` retain them during review. `reopen`, `unpark`, and `unblock` restore
none: re-state the main and any distinct worker identity with `update` when
the task resumes. History retains the former ownership after clearing.

Handles locate resumable work; retrospectives belong in artifacts and PR links
in `--ref`. Values cannot contain `·` surrounded by spaces because transition
history uses that separator. A queued task must retain a nonblank main session;
release a reservation with `unqueue <id> "reason"`.

## Artifacts: frozen records

Specs, plans, session logs — frozen documents attached to the work, stored in the
DB (not files), addressed as `KEY-aN`:

```sh
mimir attach KEY-9 --file plan.md                     # title defaults to basename
cat report.md | mimir attach KEY-9 --title "Perf report" --tag plan
mimir attach --project KEY --file log.md --tag session_log   # project-level, no node
```

- `--title` is required when piping from stdin; always pass a real one — it is the
  human handle when tag hygiene is sloppy.
- `--summary "…"` adds the optional lede (≤256 chars) — what the artifact says,
  for a reader scanning a list of them. Omit it when the title already tells all.
- Artifacts are **append-only**: correct one by attaching a successor.
- Classify by tag (`spec`, `plan`, `session_log` — see `references/tags.md`), find
  by tag + time, read back with `mimir get KEY-a3 --col content`.

## Tagging

```sh
mimir tag KEY-9,KEY-a3 spec v2
mimir untag KEY-9 v2          # plain delete, unlogged — tags are cheap
```
