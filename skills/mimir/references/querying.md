# Querying: asking the board questions

Inside a bound repo every command is already scoped to the bound project; `-s KEY`
targets another project, `-s all` spans all of them. Selection flags AND-compose.
A well-formed query matching nothing is an **empty set + a stderr warning with the
expected values** (exit 0) — only structurally bad invocations error (exit 2).

`list` selects **tasks**. Containers (initiatives/phases) are reached by id
(`get`/`status`) or explicitly: `--status all --eq type:initiative`.

## 1. Orientation — one command

```sh
mimir overview          # the whole boot picture, attention-ordered
```

Sections, attention-ordered: **header** (project rollup distribution + status
word) · **direction** (the owned `## Next` prose, verbatim, of the project and of
every container parenting live work — in flight or ready; top 5 of the true
count, the rest named) · **in flight** (`in_progress` +
`under_review`, uncapped, each row showing its resume handles as
`harness@host · branch · session` when set) · **next** (the ready head, top 5 of
the true count) · **awaiting** (dep-gated, top 5, each row naming what it
awaits) · **recent sessions** (top 5: the session id, its window, the tasks it
touched, and the lede of the `session_summary` artifact that covers it) ·
**hygiene** (untriaged/blocked/stale/dropped counts, each nonzero count naming
its follow-up command, with the first 5 rows behind it — blocked and stale
tasks carry their attention lane, untriaged seeds their lede). In flight comes
before next by design — orienting via `next` alone is the classic trap (it
**excludes `in_progress`**), and overview structurally avoids it.

Every count in the render is a TRUE total — except recent sessions, whose
header reads `N shown`. That section is composed from bounded reads and has no
knowable total: `mimir artifacts -t session_summary` is the pageable view.

Recent sessions is derived, not stored: transition rows grouped by the `session`
handle `mimir start --session …` stamped. A retrospective joins on by linked-task
overlap — attach it with `mimir attach <task> --file retro.md -t session_summary
--summary "…"`. Two limits are worth knowing:

- **Only handle-moving boundaries are visible.** `start` and the clearing verbs
  (`done`/`abandon`, `park`/`block`) echo handles; `submit`/`return`/`reopen`/
  `unpark`/`unblock` do not. A session that only reviewed work shows up solely
  through its retrospective, as a knowledge-only entry.
- **A takeover must re-state its session.** A clearing row echoes whatever the
  task still carried, so resuming someone else's work without
  `mimir update <id> --session …` credits your `done` to their session.

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
mimir get KEY-9                    # the full two-axis detail of one task
```

A started-but-held task reads as the hold word (`blocked`/`parked`), **not**
`in_progress`, in lists and rollups — "set aside" is the glance-fact. `get` shows
both axes (`lifecycle` / `hold`), so use it when the single word isn't enough.

## 3. Triage and hygiene

```sh
mimir list --is stale              # live tasks gone quiet — the nudge list
mimir list --status blocked       # manually stuck; reasons shown
mimir list --status awaiting      # dep-gated; self-clears when prereqs finish
mimir list --is orphaned           # live stragglers whose siblings all finished
```

`blocked` (someone marked it stuck) and `awaiting` (edges say it must wait) are
different signals — chase blocked, leave awaiting alone. Verdicts negate too:
`--not-is stale`.

To _read_ the verdicts on one record instead of filtering by them, ask for the
`verdicts` column — `mimir get KEY-9 --col verdicts` adds the derived
`stale`/`blocking`/`orphaned` flags to the detail (they're always present in
the HTTP API's records).

## 4. Filtered queues

```sh
mimir next -p p0                   # only the urgent ready work
mimir next --eq size:small         # quick wins
mimir list -t release:v0.3 --status all     # everything in a release tag
mimir list --eq priority:p1 --missing size  # grooming: p1 tasks nobody sized
mimir list -s all --is stale       # cross-project hygiene sweep
```

Operators take `FIELD:VALUE` tokens: `--eq/--not-eq`, `--in/--not-in` (csv any-of),
`--has/--missing FIELD` (presence), and date ops `--before/--on/--after/`
`--not-before/--not-after FIELD:YYYY-MM-DD`. Fields are the projection fields
(`type`, `priority`, `size`, `tag`, `created_at`, …); `tag` is multi-valued
(eq = contains, missing = untagged).

## 5. Drill-down

```sh
mimir get KEY-9                    # full record: deps, tags, annotations…
mimir get KEY-9 --col history      # + the transition log
mimir status KEY-3                 # a container's distribution — the WHY of its word
mimir get KEY-a2 --col content     # an artifact's frozen body
mimir get KEY                      # the whole project: children + distribution
```

## 6. Artifacts — the frozen work products

```sh
mimir artifacts                         # this board's artifacts, newest first
mimir artifacts -s all -t session_summary   # every board's session retrospectives
mimir artifacts --since 2026-07-01 -q vault # windowed, title substring
mimir artifacts -f ids | head -1        # the newest id, to feed a get
```

`artifacts` is the cross-project sibling of `list`: AND-composed filters, the
same formats, exit 0 on an empty set. Unlike `overview` it accepts `-s all`.
Rows are metadata only — id, project, title, tags, the `summary` lede,
`created_at`; the frozen body comes from `mimir get KEY-aN --col content`.
`--limit`/`--offset` page the newest-first feed, and `artifacts` specifically
puts its "why nothing came back" note on **stderr** (including when `--offset`
lands past the end), leaving stdout a clean machine contract.

## 7. Reporting and scripting

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
