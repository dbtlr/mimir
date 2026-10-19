# Querying: asking the board questions

Inside a bound repo every command is already scoped to the bound project; `-s KEY`
targets another project, `-s all` spans all of them. Selection flags AND-compose.
A well-formed query matching nothing is an **empty set + a stderr warning with the
expected values** (exit 0) — only structurally bad invocations error (exit 2).

Contents: [1. Orientation](#1-orientation--one-command) ·
[2. What's in the middle?](#2-whats-in-the-middle) ·
[3. Triage and hygiene](#3-triage-and-hygiene) · [4. Filtered queues](#4-filtered-queues) ·
[5. Drill-down](#5-drill-down) · [6. Artifacts](#6-artifacts--the-frozen-work-products) ·
[7. Search](#7-search--find-any-record) · [8. Reporting and scripting](#8-reporting-and-scripting)

`list` selects **tasks**. Containers (initiatives/phases) are reached by id
(`get`/`status`) or explicitly: `--status all --eq type:initiative`. Projects
have their own listing, `mimir projects`, which ignores the binding: it lists
every active project, and `--status archived` (or `all`) opens the archived
shelf that every other read hides.

## 1. Orientation — one command

```sh
mimir overview          # the whole boot picture, attention-ordered
```

Sections, attention-ordered: **header** (project rollup distribution + status
word) · **direction** (the owned `## Next` prose, verbatim, of the project and of
every container parenting live work — in flight or ready; top 5 of the true
count, the rest named) · **in flight** (`queued` + `in_progress` +
`under_review`, uncapped, each row showing its resume handles as
`harness@host · branch · session` plus a distinct worker when set) · **active scratchpads** (true
count, top 5 — `uuid · project · title · N open Agenda · age · linked KEY…`,
interrupted freezes flagged `freezing`; the resume surface for unsettled
episodes, `references/scratchpad.md`) · **next** (the ready head, top 5 of
the true count) · **awaiting** (dep-gated, top 5, each row naming what it
awaits) · **recent sessions** (top 5: the session id, its window, the tasks it
touched, and the lede of the `session_summary` artifact that covers it) ·
**hygiene** (untriaged/blocked/stale counts, each nonzero count naming
its follow-up command, with the first 5 rows behind it — blocked and stale
tasks carry their status word, untriaged seeds their lede; parked seeds
are a count only). In flight comes
before next by design — orienting via `next` alone is the classic trap (it
**excludes `queued` and `in_progress`**), and overview structurally avoids it.

Every count in the render is a TRUE total — except recent sessions, whose
header reads `N shown`. That section is composed from bounded reads and has no
knowable total: `mimir artifacts -t session_summary` is the pageable view.

Recent sessions is derived, not stored: transition rows grouped by the main `session`
handle stamped by `queue` or `start` (with explicit main identity;
separate worker flags identify a distinct whole-task owner). A retrospective joins on by linked-task
overlap — attach it with `mimir attach <task> --file retro.md -t session_summary
--summary "…"`, or, when the session ran on a Scratchpad, freeze that instead
(`references/finishing.md`). Two limits are worth knowing:

- **Only handle-moving boundaries are visible.** `queue`, `start`, and the clearing verbs
  (`unqueue`, `done`/`abandon`, `park`/`block`) echo handles. Explicit identity
  updates append assignment history. `submit`/`return`/`reopen`/`unpark`/`unblock`
  do not attach a new identity. A session that only reviewed work shows up solely
  through its retrospective, as a knowledge-only entry.
- **A takeover must re-state its session.** A clearing row echoes whatever the
  task still carried, so resuming someone else's work without
  `mimir update <id> --session …` (and worker flags for a distinct owner)
  keeps the previous ownership on the record.

Direction prose is written, not derived: `mimir update <KEY|container> --direction
"…"` re-authors the whole section. A dormant container's prose stays one
`mimir get` away.

The singles remain the drill-down surfaces beneath each section:

```sh
mimir status KEY        # the shape: rollup distribution + one status word
mimir list              # the live board (every non-terminal task)
mimir next              # the full READY set, in rank order (overview caps at 5)
```

## 2. What's in the middle?

```sh
mimir list --status in_progress
mimir list --status queued --eq session:<id>   # your run's outstanding reservations
mimir get KEY-9                    # the full two-axis detail of one task
```

A started-but-held task reads as the hold word (`blocked`/`parked`), **not**
`in_progress`, in lists and rollups — "set aside" is the glance-fact. `get` shows
both axes (`lifecycle` / `hold`), so use it when the single word isn't enough.

## 3. Triage and hygiene

```sh
mimir list --is stale              # live tasks gone quiet — the nudge list
mimir list --status blocked       # manually stuck; reasons shown
mimir list --status blocked --eq block_owner:you   # only the blocks waiting on you
mimir list --status awaiting      # dep-gated; self-clears when prereqs finish
mimir list --is orphaned           # live stragglers whose siblings all finished
```

`blocked` (someone marked it stuck) and `awaiting` (edges say it must wait) are
different signals — chase blocked, leave awaiting alone. Verdicts negate too:
`--not-is stale`.

To _read_ the verdicts on one record instead of filtering by them, ask for the
`verdicts` column — `mimir get KEY-9 --col verdicts` adds the derived
`stale`/`blocking`/`orphaned` flags to the detail (they're always present in
the console's records).

## 4. Filtered queues

```sh
mimir next -p p0                   # only the urgent ready work
mimir next -q vault                # ready titles containing vault (case-insensitive)
mimir next --eq size:small         # quick wins
mimir next --eq grooming:groomed   # ready work that is understood well enough to run
mimir list --query health          # live titles containing health
mimir list -t release:v0.3 --status all     # everything in a release tag
mimir list --eq priority:p1 --missing size  # grooming: p1 tasks nobody sized
mimir list -s all --is stale       # cross-project hygiene sweep
```

`next`, `list`, and `overview` rows show each `todo` task's grooming state
(`not_groomed`, `needs_answers`, `groomed`) between priority and parent.
`--eq grooming:groomed` narrows to groomed work. `next` keeps its rank order
and membership, so prefer groomed tasks when you choose, and read an
ungroomed task's notes before you start it. `mimir get` shows a task's
`grooming` line (`references/status-model.md`).

`-q`/`--query` case-insensitively matches a title substring and AND-composes with
the other selectors. Operators take `FIELD:VALUE` tokens: `--eq/--not-eq`, `--in/--not-in` (csv any-of),
`--has/--missing FIELD` (presence), and the date ops
`--on/--before/--after/--at-or-before/--at-or-after FIELD:DATE`. Fields are the
projection fields (`type`, `priority`, `size`, `tag`, `created_at`, …); `tag` is
multi-valued (eq = contains, missing = untagged).

`DATE` is a bare `YYYY-MM-DD` — read as a calendar day in **your** timezone,
this machine's unless `--tz <IANA>` says otherwise — or a timestamp carrying `Z`
or a `±HH:MM` offset (a zone-less timestamp is refused). `--on` takes a bare
date only. The bounds are half-open days, so `--at-or-before created_at:2026-07-31`
means "through the end of July 31 where you are", with no final-millisecond
trickery. The same grammar windows `artifacts` and `seeds` by `created_at`.

## 5. Drill-down

```sh
mimir get KEY-9                    # full record: deps, tags, annotations (count only)…
mimir get KEY-9 --col history      # + the transition log
mimir get KEY-9 --col annotations  # expand annotation bodies (timestamp + content)
mimir status KEY-3                 # a container's distribution — the WHY of its word
mimir get KEY-a2 --col content     # an artifact's frozen body
mimir get KEY                      # the whole project: children + distribution
```

## 6. Artifacts — the frozen work products

```sh
mimir artifacts                         # this board's artifacts, newest first
mimir artifacts -s all -t session_summary   # every board's session retrospectives
mimir artifacts --at-or-after created_at:2026-07-01 -q vault  # windowed
mimir artifacts -f ids | head -1        # the newest id, to feed a get
```

`artifacts` is the cross-project sibling of `list`: AND-composed filters, the
same formats, exit 0 on an empty set. Unlike `overview` it accepts `-s all`.
Rows are metadata only — id, project, title, tags, the `summary` lede,
`created_at`; the frozen body comes from `mimir get KEY-aN --col content`.
`--limit`/`--offset` page the newest-first feed, and `artifacts` specifically
puts its "why nothing came back" note on **stderr** (including when `--offset`
lands past the end), leaving stdout a clean machine contract.

## 7. Search — find any record

```sh
mimir search MMR-42                 # that record, then the records linked to it
mimir search 42                     # a bare number resolves in the bound project
mimir search "cross record"         # titles first, then descriptions
mimir search palette -s all -n 5    # every project, five results
```

Use `search` when you do not know which kind of record you want or where it
lives: it reaches tasks, containers, projects, seeds, and artifacts at once. An
ID query returns the record plus its parent, children, dependencies, artifacts,
and seed links, each labelled. Use `list -q` to filter a known task queue by
title; it does not read descriptions or other record types. Each hit's `match`
says how it was found (`id`, `title`, `description`, or `link`), and description
hits carry a `snippet`. A quote or several words are one query. When no title
or description matches the words, an abbreviation such as `srch` still finds
titles that hold its letters in order.

## 8. Reporting and scripting

```sh
mimir list --status done --after completed_at:2026-06-01    # what shipped since
mimir next -f ids | head -1                                 # the single next task
mimir list -f jsonl | jq -r 'select(.priority=="p0").id'    # machine contract
ID=$(mimir create task "…" --parent KEY-2 -f ids)           # compose with the echo
```

Formats: `table`/`records` (human, never parse) · `ids`/`json`/`jsonl` (stable
machine contract, no color). Piped output defaults to `ids`. Exit codes: 0 ok
(including empty sets), 1 operational (missing id, invariant), 2 bad invocation.
Rank is never a field — **array order is the order**.
