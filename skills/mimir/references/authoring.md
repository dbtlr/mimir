# Authoring: create, structure, record

Every mutation echoes the affected id — capture it with `-f ids`; never guess the
next sequence number (numbers are never reused; a guess writes to the wrong row).

## Creating work

```sh
mimir create initiative "Goal-level body of work" --parent KEY [--desc "…"] [--tag t]...
mimir create phase "A testable increment / baseline" --parent KEY-3 [--target "v1.0"]
mimir create task "A discrete, verifiable outcome" --parent KEY-4 \
    [--priority p0..p3] [--size small|medium|large] [--desc "…"] [--ref JIRA-123] [--tag t]...
```

- An initiative's parent is the bare project `KEY`; phases parent to initiatives;
  tasks parent to phases **or directly to initiatives** (skip levels the work
  doesn't need).
- `priority`/`size` are optional **signals** — they filter and advise; they never
  reorder the queue. Leave them off rather than guessing.
- A title that begins with a dash needs the `--` terminator so it isn't read as
  a flag: flags first, then `-- <title>` —
  `mimir create task --parent KEY-4 -- "--flag-name is misparsed"`.
- `create <type>` is the single creation verb for tree nodes — one verb, a type
  positional, not one top-level verb per type. `seed` and `attach` are the only
  sanctioned exceptions: each earns its own verb because the creation ergonomics
  ARE the feature (zero-friction capture; the relation itself is the command's
  point) — see `references/seeds.md` and Artifacts, below.

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

## Patching vs annotating

```sh
mimir update KEY-9 --title "…" --desc "…" --priority p1 --size small --ref X --target Y
mimir annotate KEY-9 "Realized the parser must be rewritten; filed KEY-12."
```

- `update` patches scalar **fields**; it cannot touch status (verbs only).
- `update KEY-aN --title "…" --summary "…"` patches an artifact — title and
  summary are its two mutable fields (content is frozen; attach a new artifact
  to correct one).
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
  Read it, decide what is still true, write the new whole. Never paste an
  addition onto a stale draft.
- The write is CAS-guarded like every other. If a concurrent write landed first,
  it refuses — **re-read and merge**, then write again. Never replay the draft
  you composed against the old state (ADR 0026).
- Re-writing identical text writes nothing, so an idempotent re-author doesn't
  move `updated_at` (and doesn't fake activity).
- The flag is `--direction`, not `--next` (`--next` belongs to `self-update`).
  The field is spelled `next` on MCP, HTTP, and `--col next`.
- It is an `update` flag only — set the narrative after the container exists;
  `create --direction` is refused rather than silently dropped.
- A refusal naming a duplicate `## Next` means the document was hand-edited into
  two sections — `mimir doctor` points at the extra heading; delete it, then
  re-author.

## Resume handles: how the work is picked back up

```sh
mimir start KEY-9 --host $(hostname) --harness codex --session "$SESSION" --branch feat/key-9
mimir update KEY-9 --session "$SESSION" --branch feat/key-9   # resuming, or taking over
mimir update KEY-9 --session ''                               # a blank clears one
```

Set them at `start` — they answer what is happening, what did happen, and how to
continue. There is **no claim verb**: `in_progress` is the claim, so resuming a
task you left or taking one over from another agent is a plain `update`
overwrite of the same four fields. Set what you actually know and leave the rest
absent; an unclaimed task legitimately carries none.

`done`/`abandon` and `park`/`block` clear all four, so a settled or held task
never carries a stale pointer. `submit` and `return` keep them — the branch and
session are still live while a human reviews. `reopen`/`unpark`/`unblock` restore
nothing: when you pick the work back up, re-state the handles with `update`.

Keep them handles, not telemetry — a session id, not what happened in the
session. The retrospective belongs in an artifact; the PR link belongs in `--ref`.
One character rule: a value can't contain `·` surrounded by spaces — the
transition log uses that separator to record handle moves, so the write refuses
rather than storing a value the log would mis-read.

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
- Artifacts are **append-only**: never edit one; correct by attaching a successor.
- Classify by tag (`spec`, `plan`, `session_log` — see `references/tags.md`), find
  by tag + time, read back with `mimir get KEY-a3 --col content`.

## Tagging

```sh
mimir tag KEY-9,KEY-a3 spec v2
mimir untag KEY-9 v2          # plain delete, unlogged — tags are cheap
```
