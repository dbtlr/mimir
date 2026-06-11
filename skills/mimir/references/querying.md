# Querying: asking the board questions

Inside a bound repo every command is already scoped to the bound project; `-s KEY`
targets another project, `-s all` spans all of them. Selection flags AND-compose.
A well-formed query matching nothing is an **empty set + a stderr warning with the
expected values** (exit 0) — only structurally bad invocations error (exit 2).

`list` selects **tasks**. Containers (initiatives/phases) are reached by id
(`get`/`status`) or explicitly: `--status all --eq type:initiative`.

## 1. Orientation — in this order

```sh
mimir status KEY        # the shape: rollup distribution + one status word
mimir list              # the live board (every non-terminal task)
mimir next              # the READY set, in rank order
```

`next` last, because it **excludes `in_progress`** — it answers "what could I pick
up next", not "what is going on". Orienting via `next` alone is the classic trap:
you will miss work already underway.

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

## 6. Reporting and scripting

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
