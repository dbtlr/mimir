---
title: 'mimir Output Contract Reference'
status: accepted
date: 2026-06-04
last-updated: 2026-08-05
---

# mimir Output Contract Reference

The external-facing shape of Mimir's **intent envelope** — the surface both the **CLI** and **MCP** render (see glossary **Envelope**, **Output contract**). Mimir's binding of the Norn output standard adopted in [ADR 0009](decisions/0009-adopt-norn-output-and-selection-contract.md); the _why_ is there, this note holds the concrete _shape_.

> **Maintained reference, not a frozen artifact.** Seeded during design with what's locked; the build completes it (exit-code table, full verb list, error envelope, worked per-format examples) and keeps it honest. Prefer the ADRs over this note where they conflict.

## Selection vs. projection (the spine)

Commands differ in **one axis only — how they identify rows.** Everything downstream is one shared contract.

- **Set selection** (broad): `next` / `list` — `--status` universe + `--is` verdicts + field operators (§Selection & filter surface). `projects` is the project-level set: `--status active|archived|all` picks the shelf, and the binding never narrows it (`MMR-406`).
- **Identity selection** (targeted): `get <id>…` — by rendered id (grammar below).
- **Identical capabilities, selection-appropriate defaults** (below).

## Selection & filter surface (groomed 2026-06-10 — `MMR-33`/`MMR-37`; built, shipped in v0.2.0)

Supersedes `--predicate`. Three orthogonal pieces, AND-composed; **no OR** (accepted — `--in` covers within-field any-of). The DTO field renames `state` → **`status`** in the same stroke (one word on every surface; ADR 0008 Refinement).

- **`--status <word>`** — the selection **universe**. Vocabulary = the closed status words (`ready` `awaiting` `queued` `in_progress` `under_review` `blocked` `parked` `done` `abandoned`) + unions: **`live`** (the default — today's misnamed `all`), **`terminal`**, **`all`** (now honestly everything). Terminal selections order by `completed_at` desc (no rank outside the rankable set).
- **`--is <verdict>` / `--not-is`** — the derived verdicts that aren't statuses: `stale`, `blocking`, `orphaned` (future `buried`). Repeatable.
- **Field operators** — Norn's dogfooded `find` dialect, ported verbatim: `--eq`/`--not-eq FIELD:VALUE` · `--in`/`--not-in FIELD:V1,V2` (ANY-of) · `--has`/`--missing FIELD` · the five date ops `--on`/`--before`/`--after`/`--at-or-before`/`--at-or-after FIELD:DATE` ([ADR 0029](decisions/0029-caller-zoned-date-semantics.md)). Repeatable, AND-ed. **Queryable fields = the projection's bare fields** (no second vocabulary). **`tag` is a multi-valued pseudo-field**: `eq` = contains, `in` = any, `not-in` = none, `missing` = untagged.
- **Date filters are caller-zoned** — one grammar for every date-bearing resource: the three node timestamps, an artifact's `created_at`, a seed's `created_at`. A bare `YYYY-MM-DD` is the **caller's** calendar day, resolved through one request-wide IANA timezone — the CLI's `--tz` (default: the invoking system's zone), MCP's `tz` argument, the browser's detected zone from the console. MCP and the Engine **refuse** a bare date with no zone. Windows are half-open (`on` runs from the day's opening instant up to the next day's, so a 23- or 25-hour DST day is exactly that long); `after` starts at the next day's opening instant and `at-or-before` ends there. A timestamp must carry `Z` or a numeric offset — zone-less is refused — and `before`/`after` are strict where `at-or-before`/`at-or-after` include the instant. `on` takes a bare date only.
- **Text search (`-q`/`--query`, `q`; `MMR-78`, `MMR-454`)** — a case-insensitive substring over a node's **title or its rendered id**, so `q=mmr-45` finds `MMR-45`, `MMR-450`, and any title naming them. `%` and `_` act as LIKE wildcards. `list` and `next` share it on CLI, MCP, and the Engine's `openTasks` (`q`). The artifact feed's `q` stays title-only.
- **Composition rule:** `--status` picks the universe; operators filter within it. No mode-switching on flag presence.

**Value faults warn, structural faults fail.** A well-formed request matching nothing is an _empty set_, not an error: an enum miss (`priority:p9`) → **exit 0, empty result, warning**. Unknown field, operator-on-incompatible-type, or an unreadable date (`created_at:notadate`, `created_at:2026-02-30`, a zone-less timestamp, a bare date with no caller zone) → **usage, exit 2** (the caller's program is wrong — an unreadable bound is a question that cannot be answered, not a selection that matches nothing). Warnings are the non-fatal member of the diagnostic family — stderr, mirroring the error envelope, with zod-style correction info:

```json
{
  "warning": {
    "code": "no_match_value",
    "field": "priority",
    "value": "p9",
    "message": "p9 is not a priority",
    "expected": ["p0", "p1", "p2", "p3"]
  }
}
```

Human formats render a `⚠` note line on stderr next to the `0 tasks` count. MCP (no stderr, no exit codes) folds `warnings` into the response payload beside the result.

**The transition log is deliberately not a query surface.** It exists as carved-out substrate (ADR 0003); consolidation runs read it raw and shape it themselves. "What got done since X" is a stored-fact query: `list --status done --at-or-after completed_at:<ts>`.

## Identity grammar (addressability contract)

_Groomed 2026-06-10 from dogfood findings; implementation: `MMR-32`._

Every entity has **exactly one rendered id**, and every surface speaks it — echoes, errors, facets, deps, history, JSON DTOs, MCP envelopes. Internal integer ids never cross the surface.

| entity                            | rendered id                           | example  |
| --------------------------------- | ------------------------------------- | -------- |
| project                           | bare `KEY`                            | `MMR`    |
| tree node (initiative/phase/task) | `KEY-seq`                             | `MMR-22` |
| artifact                          | `KEY-aN` (project-scoped, like tasks) | `MMR-a1` |

- **Any id-position accepts the full grammar; the _verb_ rejects types it can't act on** as a behavioral error (`done MMR` → "MMR is a project, not a task"). No per-verb parser carve-outs.
- **Selector flags are not id-positions** — `--scope` takes a project `KEY`, `--parent` a container id; their narrowness is behavioral too.
- Supersedes the Phase-3 `#N` artifact echo (global integer, shell-hostile `#`) — a pre-release contract fix, no external consumers.

## Projection vocabulary (`--col`)

One **flat, closed** vocabulary on every selection front-end — _the dot-facet prefix is dropped_ (groomed 2026-06-10, `MMR-38`). The dot was a Norn carryover whose justifying condition doesn't travel: Norn fences structural facets from a _dynamic, user-defined_ frontmatter namespace; Mimir's schema is closed, so no collision exists and the punctuation only taxed callers. Some columns return sets — the heavy/cheap distinction lives in **defaults** and help grouping, not syntax.

### Bare fields

| field                                        | on    | notes                                                                                                                                                       |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                         | all   | rendered `KEY-seq`; always-present identity (the `records` header — Mimir's analog of Norn's `.path`). Surrogate int never exposed (ADR 0006).              |
| `type`                                       | all   | `task` \| `phase` \| `initiative` \| `project`                                                                                                              |
| `title`                                      | all   |                                                                                                                                                             |
| `status`                                     | all   | the single derived **status word** (ADR 0008 + Refinement; field renamed from `state` 2026-06-10, `MMR-37`); for a non-leaf it is `interpret(distribution)` |
| `parent`                                     | all   | parent's `id`, or null                                                                                                                                      |
| `description`                                | all   |                                                                                                                                                             |
| `priority`                                   | task  | `p0`–`p3` or null (signal, ADR 0007)                                                                                                                        |
| `size`                                       | task  | `small` \| `medium` \| `large` or null                                                                                                                      |
| `lifecycle`                                  | task  | raw axis — `todo` \| `queued` \| `in_progress` \| `under_review` \| `done` \| `abandoned`                                                                                                 |
| `hold`                                       | task  | raw axis — `none` \| `blocked` \| `parked`                                                                                                                  |
| `hold_reason`                                | task  | or null                                                                                                                                                     |
| `block_owner`                                | task  | who can clear a block (ADR 0001, `MMR-438`) — `you` \| `others` while `hold` is `blocked`, otherwise null; `--eq block_owner:you` filters; absent on a container |
| `grooming`                                   | task  | the stored grooming judgment (ADR 0033) — `not_groomed` \| `needs_answers` \| `groomed`; `--eq grooming:groomed` filters; absent on a container          |
| `target`                                     | phase | the milestone the phase aims at                                                                                                                             |
| `external_ref`                               | task  | GitHub issue/PR linkage, or null                                                                                                                            |
| `upstream`                                   | task  | the requester-side seed pointer (`KEY-sN`, MMR-244/245), reference-only, or null                                                                            |
| `pinned` | project | the operator's pin (`MMR-493`) — `true` \| `false`, always present on a project, absent on every other node; written with `update KEY --pinned`/`--not-pinned` (MCP `update` `pinned`, Engine `updateProject` `pinned`), and refused on a task, container, seed, or artifact. The `records` view shows a `pinned  yes` row only while it is set |
| `remote` | project | the normalized Git remote (`MMR-543`, ADR 0036) — `host/path`, or null; present on every project view. Written with `create project --remote` and `update KEY --remote` (MCP `create`/`update` `remote`, Engine `create`/`updateProject` `remote`); a blank clears it on update; refused on a task, container, seed, or artifact. The `records` view shows a `remote` row only while it is set |
| `created_at` / `updated_at` / `completed_at` | all   | ISO-ms-`Z` UTC; rendered local only at the edge                                                                                                             |
| `last_activity_at`                           | project | `MMR-494` — the newest instant of anything in the project: its own row, nodes, transitions, annotations, seeds, artifacts, scratchpads. ISO-ms-`Z` UTC, never null, never before `updated_at`; a project with no children reports its own `updated_at`. Rides every project read and list on the Engine, MCP, and CLI `json`/`jsonl`/`records`. Absent on a task or container |

**`status` and the raw axes deliberately coexist.** `status` is the glance; `lifecycle`/`hold` are the detail a script automating a _transition_ must read (it can't reliably parse the collapsed word back into axes). `next` shows only `status`; `get` shows both.

**`rank` is not a field.** Per ADR 0007 the numbers are core-owned; array _order_ carries the intent. A consumer wanting another order filters/sorts by signals (`priority`, `size`), never rank.

### Set-valued columns (heavier — same flat vocabulary)

- `deps` — what this node depends on, plus the derived `blocking` reverse set.
- `annotations` — freeform in-flight notes. On `get` (a cheap default facet there — `list`/`next` omit it unless requested via `--col annotations`), structured formats (`json`/`jsonl`) carry the full array (`content` + `createdAt`, chronological); the styled `records` view stays a compact count (`annotations  3`) unless `--col annotations` is given, which expands every entry onto its own line with its timestamp and content — one entry per line, since unlike `history`'s terse machine tokens, annotation prose can itself contain `; ` or span multiple lines (MMR-361).
- `artifacts` — attached artifacts: **`id` (`KEY-aN`), required `title`, tags, `created_at`** (groomed 2026-06-10, `MMR-34`: title is a required column — CLI defaults to the `--file` basename, MCP requires it; `attach` grows `--tag`; classification stays tags per ADR 0004, never a kind enum). **Bodies** via `get KEY-aN --col content` — realigning with this note's original `get <artifact-id>` intent, which Phase 3 under-delivered (the `#N` echo was unaddressable).
- `lede` _(`MMR-454`)_ — the one-line list preview, opt-in on `list`/`next` rows (`--col lede`). The row's stored `summary` when non-empty, else the lede derived from its description at read time (plain text, whitespace flattened, cut at a word boundary to 240 characters — the seed rule of ADR 0021), else `null`. Live and terminal rows alike. Descriptions are read in one batch for the rows returned; if that read fails the rows carry `lede: null` and a note goes to stderr. Without the column no `lede` key appears. The CLI table shows it as a dim second line; `records` as a `lede` row.
- `links` _(`MMR-454`, artifact feed)_ — each `artifacts` feed item (`mimir artifacts -f json`, the MCP `artifacts` tool, the Engine's `artifacts`) carries `links`: the rendered ids (`KEY-seq`) of the records the artifact is attached to, in code-unit order — the same ids `get KEY-aN` shows, always present, `[]` when the artifact is attached to nothing.
- `content` — an **artifact's** frozen body. The one deliberately heavy column; opt-in always.
- `history` — the transition log (`kind`, from→to, `at`, `reason`). Heavy; opt-in even on `get`.
- `tags` — tags on this node.
- `children` — child nodes (`id` + `status`) for tree navigation.
- `distribution` — a non-leaf's rollup breakdown (`{done:3, ready:1}`); pairs with the `status` label (ADR 0008).
- `verdicts` — the non-status derived predicates in one read: `{stale, blocking, orphaned}` booleans (the `--is` vocabulary; the status word carries everything else). Added at Phase 4 (`MMR-14`) for the API record's always-on derivation; opt-in via `--col verdicts` on the CLI/MCP.

## Selection-appropriate defaults

- **`next` / `list`** (broad) → lean: **`id, status, priority, parent, title`** — `parent` is the row's hierarchy anchor (added `MMR-87`; `description` stays out, it's one `get` away once a row is picked). The `table` rows also show the task's `grooming` word (`MMR-464`, ADR 0033); the structured formats carry it as the `grooming` field on every task.
- **`get <id>`** (targeted) → full record: all scalar fields + cheap set columns (`deps`, `tags`, `children`, `distribution`, `annotations`, `artifacts`); heavy `history`/`content` stay opt-in.
- A broad "full structured dump" modifier (`--all-cols`) includes every bare field + cheap facet, excludes heavy/expensive facets (Norn's `--all-cols` semantics).

## Formats (two-layer split)

_Layout style_ — the styled formats `records` + `table` (colors, icons, spacing) — is **evolvable and never parsed**; the _structural contract_ (`ids`/`json`/`jsonl`) is a **versioned promise**. Structured formats never emit ANSI; set-returning commands lead with a count.

**`isTTY` governs _decoration_ only, never _information_ (`MMR-87`).** The default is `table` for a set, `records` for a single node — **the same fields whether interactive or piped**; a pipe only drops the ANSI (color is already suppressed by `plain = NO_COLOR || !isTTY`). `ids`/`json`/`jsonl` are **explicit `-f` opt-ins**: `ids` for a genuine shell pipeline, `json`/`jsonl` to parse the embedded facet arrays. The non-TTY consumer is overwhelmingly an agent reading to decide (the ADR 0011 skill path), for whom bare ids carry no decision information; the old "pipe → `ids`" default optimized for a `| xargs` consumer that barely exists. (`status` is json everywhere; the `self-update` **report** keeps its split — prose in a terminal, json piped — see `MMR-59`.)

| format    | role                                                                                                                                   | stable?                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `table`   | **set-view default** (`next`/`list`, piped or TTY) — one task per line; icon+color highlight `state` (TTY only); rank order, count-led | no — styled, never parse it |
| `records` | **detail default** (`get`, piped or TTY) — bold `id` header + aligned `label  value` rows                                              | no — styled, never parse it |
| `ids`     | **explicit opt-in** (`-f ids`) — one `KEY-seq` per line; the composable pipeline / id-capture form                                     | yes                         |
| `json`    | one-shot — tight wrapper `{ total, returned, starts_at, tasks: [ … ] }` (array key = unit)                                             | yes, versioned              |
| `jsonl`   | streaming — one object per line, no wrapper                                                                                            | yes                         |

Wrapper carries nothing derivable (`truncated = returned < total`). Array key names the unit (`tasks`; other units as verbs are added).

### The `table` format (set-view rendering)

One task per line — `id`, a `state` cell, `priority`, `grooming`, `parent`, `title` — scannable top-to-bottom in rank order, led by a count line. State is highlighted by an **icon + color**, but the state **word** is always present in the cell: color/icon only _highlight_, so `--ascii` and NO*COLOR fallbacks lose nothing ([ADR 0009](decisions/0009-adopt-norn-output-and-selection-contract.md) / Norn's "color is decoration, never information"). The \_roles* — a distinct icon + color per **State word** — are fixed; the exact glyph set and palette are a **brand-pass deferral** (Mimir's own identity, not Norn's).

```
8 tasks

MMR-16   ● ready      p1   groomed         MMR-2    write the first migration
MMR-23   ● ready      p2   not_groomed     MMR-2    core rollup functions
MMR-09   ◔ awaiting   p0   needs_answers   MMR-5    mcp read tools
```

(glyphs illustrative — pending the brand pass.)

The `grooming` cell is a word, never a symbol, and shows only for a `todo` task: a started or settled task, and every container, leaves it blank (ADR 0033 reads the state before start only). The column is dropped when no row in the set has a state to show. It never changes which tasks `next` returns or their order; `--eq grooming:groomed` narrows the set.

## Layout style — adopted, brand deferred

Adopt Norn's tool-agnostic **primitives** (count line, record block, table rows, separator, glyph set, ≤4-space indentation) and **house principles**: counts-before-contents; color is decoration, never information; structured formats never carry style; quiet by default (no banners/celebration); lowercase house style; NO_COLOR/`--ascii` lose nothing. Of the deferred brand pass, **voice is now settled** — tone, mood, casing, tags, separators, and message grammar live in the [Output Voice Guide](output-voice.md) (MMR-213); palette and identity glyphs remain deferred.

## The `overview` composite (report kind, MMR-278)

`mimir overview [-s KEY]` is a **`report`-kind** read (like `triage`):
styled sections in a terminal, one JSON envelope when piped — `-f json` forces
the envelope, `-f records` forces the sections. The set formats are category
errors here: `-f table`, `-f jsonl`, and `-f ids` are **usage** (exit 2) with a
hint at `mimir list` (a composite is not one table / a row stream / an id set).
It reads **one project** — bare uses the bound scope, `-s KEY` names it, and `-s
all` is a usage error (`run 'mimir list -s all' for a cross-project set`).

The envelope is one composite object — never the set wrapper. Task objects are
the same **lean projection** `list`/`next` emit; each `awaiting` task adds an
`awaiting_on` array of upstream ids. Every section carries its **true `count`**
even where its array is capped (`next`/`awaiting` and
`active_scratchpads.scratchpads` cap at `OVERVIEW_CAP`, currently 5;
`in_flight` is uncapped). `active_scratchpads.count` likewise reports the true
total before the cap. `hygiene` carries the `untriaged`, `blocked`, and `stale`
counts, each with a capped `listings` head, plus `parked_seeds`: a count of the
board's parked seeds with no listing, because a parked seed is set aside on
purpose and never flagged.

```json
{
  "active_scratchpads": {
    "count": 1,
    "scratchpads": [
      {
        "id": "123e4567-e89b-42d3-a456-426614174000",
        "project": "MMR",
        "title": "Console parity",
        "linked_work": ["MMR-332"],
        "state": "active",
        "open_agenda": 2,
        "updated_at": "2026-08-04T12:00:00.000Z"
      }
    ]
  },
  "awaiting": {
    "count": 12,
    "tasks": [{ "id": "MMR-9", "status": "awaiting", "awaiting_on": ["MMR-2", "MMR-3"] }]
  },
  "hygiene": { "blocked": 1, "parked_seeds": 1, "stale": 2, "untriaged": 3 },
  "in_flight": {
    "count": 2,
    "tasks": [{ "id": "MMR-16", "status": "in_progress" }]
  },
  "next": { "count": 8, "tasks": [{ "id": "MMR-23", "status": "ready" }] },
  "project": {
    "distribution": { "ready": 8, "done": 5 },
    "id": "MMR",
    "status": "in_progress"
  }
}
```

The MCP `overview` tool returns the identical envelope; the Engine's `console.overview`
returns the same report with camelCase fields and `Date` instants.

## The work page (console report, MMR-469)

The Engine's `console.projectWork` (by project key) and `console.nodeWork` (by
node id) return the console work page for a project, or for an initiative or
phase and its whole subtree. A task id is refused (`validation`); an unknown or
archived id is `not_found`. Both **require `timeZone`**, the caller's IANA zone,
and refuse a missing or unknown zone with `validation`: it decides where the
`shipped` days begin and end (ADR 0029), and there is no fallback zone. The page
has no CLI or MCP form yet. The field names below are the report's snake_case
specification names; the Engine returns them in camelCase (`needsYou`,
`goingCold`, `startedAt`) with `Date` instants.

The envelope is one composite object. Rows are tasks, plus the initiatives and
phases that read to break down (in `frontier.to_groom` only), and no section is
capped. A row appears in the first section that claims it: `now`, `needs_you`,
`frontier`, `shipped`. `going_cold` is the one exception and repeats tasks the
other sections show. Parked tasks have no row. Every row is the lean node object
`list`/`next` emit with the section's fields folded on, and every row carries
`stale` (true once the task is past the stale threshold; a finished task is
never stale, so it is always false on `shipped` rows). `type` on each row
tells a task from a container.

- `scope`: `{ kind, id, title }`, where `kind` is `project`, `initiative`, or `phase`.
- `now`: queued or in-progress tasks. Adds `started_at` (the latest queue, start, or reopen),
  `latest_note` (`{ content, created_at }` or `null`), and `scratchpads`
  (`[{ id, title }]`, the active Scratchpads anchored to the task). The agent
  context (`harness`, `branch`, `host`, `session`, `external_ref`) is on the
  task object.
- `needs_you`: under review, then blocks owned by `you`, then todo tasks whose
  grooming is `needs_answers`; newest first within each. Adds `reason`
  (`under_review`, `blocked`, or `needs_answers`) and `question` (the task's
  latest note for `needs_answers`, otherwise `null`).
- `frontier`: todo, un-held tasks that are ready or await only prerequisites
  that are in progress, under review, or ready, plus the blocked-on-others list.
  - `runnable`: groomed, ready, and ranked, in `next` order. A groomed, ready
    task with no rank has no row, as `next` omits it.
  - `next_to_unlock`: `[{ prerequisite: { id, title, status }, tasks }]`, groomed
    tasks grouped by the prerequisite they wait on. A task waiting on several
    prerequisites appears under each.
  - `to_groom`: tasks that are not groomed, in rank order, then the initiatives
    and phases in scope (the scope itself excluded) that have no children, in
    board order. A container row has `type` `initiative` or `phase` and
    `break_down: true`; every frontier row carries `break_down`, `false` on a
    task. A container follows the same
    one-step rule as a task, over its own and inherited dependency edges. A
    container with any child (finished or parked included, and an open-ended
    home counts), and a standing open-ended home itself, is not listed.
  - Every `runnable`, `next_to_unlock`, and `to_groom` row adds `awaiting_on`,
    the unsettled prerequisite ids (empty when ready).
  - `waiting_on_others`: tasks blocked with a block owner of `others`, started or
    not, oldest `updated_at` first (blocking clears rank). Adds `block_reason`
    (the task's hold reason, also on the row as `hold_reason`).
- `shipped`: tasks done or abandoned in the last seven calendar days, today
  included, in the caller's zone; newest first. Adds `finished_at` and
  `abandon_reason` (`null` for a done task).
- `going_cold`: every stale task in scope, oldest `updated_at` first, including
  tasks an earlier section shows; each row has `stale: true`.

## The review report (console report, MMR-477, MMR-504)

The Engine's `console.review` returns the console's cross-project review across
every active project (archived projects contribute nothing). It has no CLI or MCP
form. `timeZone` is required, as on the work reads: it is the caller's IANA zone
and places the `shipped` window. A missing or unknown zone is a `validation`
refusal. Field names follow the work page's convention above.

- `decisions`: per project with any, the work page's `needs_you` rows, projects
  in urgency order (leading reason, then newest, then key).
- `queue`: every decision's task id, verdicts then blocks then questions, newest
  first within each.
- `triage`: per project with anything to triage, `{ project, seeds, going_cold,
  findings }`, most first, then key.
- `last_finished`: the newest done or abandoned task, or `null`.
- `now`, `shipped`, `runnable`, `going_cold`: the work page's `now`,
  `shipped`, `frontier.runnable`, and `going_cold` rows across every active
  project. One set of section rules and row builders serves both, so a project's
  rows here equal its work report's rows. Across projects, `now` lists the most
  recently started first, `runnable` follows the `projects` order and then each
  project's own rank, `going_cold` lists the longest quiet first, and `shipped`
  lists the newest first. Every row adds `project`, the project key. A
  `going_cold` row is the task object with `stale: true`.
- `projects`: every active project, pinned first, then newest `last_activity_at`
  first, then key. Each carries `key`, `name`, and counts: `decisions`, `triage`
  (untriaged seeds + going cold + `doctor` findings), `in_flight` (status
  `queued` or `in_progress`), `live` (the `--status live` group: every status other than
  `done` and `abandoned`, so parked work counts), and `going_cold` (tasks past the stale threshold).

## Doctor diagnostics

`mimir doctor [-s KEY] [--format …]` is read-only and non-gating. A successful
diagnostic read exits `0` even when findings exist. Human findings print to
stderr as severity-tagged lines, `[err]` or `[warn]`, in the short spelling the
[Output Voice Guide](output-voice.md) sets; the wire `severity` field keeps
`error` / `warn`. JSON and JSONL findings carry `check`, `severity`, `node`,
`where`, and `message`, plus:

- `code` — stable issue code;
- `scopeKey` and `stem` — canonical identity derived from the node's `KEY-seq`;
- `locator` — the issue location, `<table>/<key>`;
- `evidence` — rule-specific structured facts.

Doctor has no repair pass and no `--fix` flag; each finding is fixed by hand at
the database. A scoped run naming a project key the store does not hold warns
`doctor scope 'KEY' matched 0 records` on stderr, so a stale scope never reads
as a clean scan.

The host serves the same findings to the console's Record-health panel through
its `doctor` server function (optionally scoped to one project key), grouped by
project:

```json
{
  "scanned_at": "2026-10-03T12:00:00.000Z",
  "finding_total": 1,
  "groups": [
    {
      "project": "MMR",
      "finding_count": 1,
      "records": [
        {
          "id": "MMR-2",
          "cause": "dangling parent",
          "severity": "error",
          "locator": "node/MMR-2",
          "field": "parent_id",
          "value": "MMR-404",
          "evidence": { "parent_id": "MMR-404" },
          "note": "MMR-2 names parent MMR-404, which no node row holds"
        }
      ]
    }
  ],
  "scope": null
}
```

`scope` is `null` for an unscoped scan, and `{ "key", "matched_records" }` for
a `?project` scan. A store-level finding, such as a schema-version mismatch,
groups under the project word `store`.

## Write contract (mutations)

Mutations are high-level verbs (never a raw `status` patch — glossary **Lifecycle verb**). Canonical names are `*_task`/`*_node`; the CLI renders them tersely.

| concern          | verb(s)                                                   | notes                                                                                                          |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| lifecycle        | `queue(session)` · `unqueue(reason)` · `start` · `submit` · `return(reason?)` · `done` · `abandon(reason?)` · `reopen(reason?)`                     | `queue` reserves todo work; `start` accepts todo or queued; `unqueue` requires a reason and clears handles; `done` stamps `completed_at`; reasons ride the transition log                                                |
| hold             | `park(reason?)` · `unpark` · `block(reason?, on?)` · `unblock` | sets/clears the `hold` overlay; never touches lifecycle. `block`'s `on` is `you` \| `others` (who can clear it); omitted, it is `others` when the task has an `upstream`, else `you`. `unblock` and `park` leave no owner. Queued tasks must be unqueued first. A held task is refused, so changing an owner is `unblock` then `block` |
| grooming         | `groom(ids, state, note?)`                                | sets the stored grooming judgment on tasks (ADR 0033); `needs_answers` requires the note; never touches lifecycle or hold, writes no transition-log row |
| dependency edges | `depend(id, --on ids)` · `undepend`                       | **not** `block` — edges produce derived `awaiting`/`blocking`; the spec's `block_task`-for-edges is superseded |
| structural       | `move(id, --to parent)`                                   | validates cycle/type                                                                                           |
| data             | `update(id, fields)`                                      | scalar patch; `status` excluded; a queued session cannot be cleared                                                                           |

- **Every mutation echoes the affected node** in the **lean projection** (`id, title, state, priority, size`) — a write needs no follow-up `get` (Norn's "prevent the extra turn"). In `--json` it returns the bare node object, **not** the set wrapper. (`attach` echoes the artifact id `{"artifact":{"id"}}`; `create project` echoes `{"project":{"key","name"}}` — the two echo exceptions.)
- Every status-bearing verb appends its history entry in the same per-document atomic write as the state change (ADR 0003). A plan spanning independent documents may partially succeed and follows ADR 0023's verify-and-retry contract rather than cross-document rollback.

### Verb surface (Phase 3 — CLI; MCP mirrors with named args)

| verb                                        | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start · done                                | `mimir done <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| abandon                                     | `mimir abandon <id> [reason]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| park/unpark · block/unblock                 | `mimir park <id> [reason]` · `mimir unpark <id>` (a seed id parks an untriaged seed or returns a parked one to untriaged, and echoes the seed; MCP `park`/`unpark` take a seed id the same way, and the Engine's `seedPark`/`seedUnpark` do too) · `mimir block <id> [reason] [--on you\|others]` · `mimir unblock <id>`. `--on` names who can clear the block and is refused on every other verb except `depend`/`undepend` and the date filters; MCP `block` and the Engine's `block` take the same `on`. The echoed node carries `block_owner` |
| depend · undepend                           | `mimir depend <id> --on <ids>` (comma-sep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| move                                        | `mimir move <id> --to <parent>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| reorder                                     | `mimir reorder <id> --top\|--bottom\|--before <id>\|--after <id>` — ranked tasks only (phases and initiatives don't rank; terminal, held, and under-review tasks are outside the rank); the rank spans the whole project, not one parent; `--before`/`--after` take any ranked task in the same project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| update                                      | `mimir update <id> [--title --desc --priority --size --target --ref]`; on a project `KEY` it patches `--name --desc --direction` `--remote` (`MMR-543`), and `--pinned`/`--not-pinned` (`MMR-493`: a converse pair like `--open-ended`; both at once is a usage error; any other id refuses them, a seed with exit 2). |
| annotate                                    | `mimir annotate <id> <text>` (or stdin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| create                                      | `create project --key K --name N [--repo --path]` · `create <initiative\|phase\|task> "title" --parent <KEY\|id> [signals] [--tag <t>…]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| attach                                      | `mimir attach <id> --file <path> [--title <t>] [--tag <t>…] [--link <ids>]` → echoes `KEY-aN`; `title` required (CLI defaults to the file basename; MCP requires it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| groom _(`MMR-464`, ADR 0033)_ | `mimir groom <ids> <state> [note]` — `<state>` is `not_groomed` \| `needs_answers` \| `groomed`; ids are space- or comma-separated and run up to the state word, and everything after it is the note, written as an annotation on each task (required for `needs_answers`). One transaction: a bad id changes nothing. Echoes `{"groomed":{"ids","state"}}` under `-f json` and the ids under `-f ids`. MCP mirrors it as the `groom` tool (`ids`, `state`, `note`) with the same echo; the Engine's `groom` takes `{ids, state, note?}`. `create task --groomed` (MCP `groomed`, Engine `create` `groomed`) creates the task already `groomed`; it is refused on any other type. |
| tag · untag _(`MMR-31`, shipped in v0.2.0)_ | `mimir tag <ids> <tag>…` · `mimir untag <ids> <tag>…` — ids comma-list × tags variadic; reaches all three entity types per the identity grammar; `untag` is a plain row delete, **not** transition-logged (membership is a fact-about-now); vocabulary free-text, conventions live in consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| seed · seeds _(`MMR-245`)_                  | `mimir seed "<title>" -k <kind> [-p KEY] [--desc …]` files a grooming-queue seed (`KEY-sN`; target + requester default from the bound board; an empty requester self-files) · `mimir seeds [-p KEY\|all] [--requester KEY] [--status <s>] [--sort asc\|desc] [--grouped]` reads the queue (live + oldest-first by default; `-p all` = every active board; `--grouped` = the lane view). Echoes the seed record (`-f ids` prints the `KEY-sN`). The wire carries `lane` (untriaged/ready/promoted/parked/settled) so consumers derive nothing. The default `live` queue is `new` + `promoted`; a parked seed is listed by `--status parked` or `all`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| get KEY-sN _(`MMR-245`)_                    | `mimir get KEY-sN` reads one seed (the resolved view + `## Seed Description` prose) — the id grammar routes s-ids to the seed reader, matching MCP `get_seed` / the Engine's `getSeed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| promote _(`MMR-245`, `MMR-259`)_            | `mimir promote KEY-sN --parent <node> [--priority --size --desc --title --tag…]` creates a task from the seed (or `--link KEY-seq` records existing work), appends the `spawned` link, and moves `new → promoted` (repeatable while promoted; `--parent`/`--link` are mutually exclusive). The default/records and `json` echo carry the seed plus a sibling `created` (the spawned task id) in create mode — on MCP too. `-f ids` is the odd one out: it prints the spawned task id (create mode) or the linked id (`--link` mode) — the id a composer wants for `ID=$(mimir promote … -f ids); mimir update $ID …` — never the seed id, and a repeated promote echoes the newly spawned id each time                                                                                                                                                                                                                                                                                                                                                                                   |
| reject · resolve _(`MMR-245`)_              | `mimir reject KEY-sN "<reason>"` · `mimir resolve KEY-sN "<resolution>"` — the terminal seed transitions; reason **required**; both reachable from `new` or `promoted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| update KEY-sN _(`MMR-245`)_                 | `mimir update KEY-sN [--title --kind --desc]` patches a live seed (the id grammar routes s-ids to the seed store); `resolved`/`rejected` seeds refuse patches. A node-only flag (`--priority`, `--size`, …) on a seed update is a **usage error (exit 2)**, not a validation error. `--upstream KEY-sN` on `create task` / `update KEY-seq` sets the requester-side seed pointer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| triage _(`MMR-246`)_                        | `mimir triage [KEY] [--dry-run] [--format …]` — the explicit-run reconciliation pass over ONE board (bare = the bound board). Three checks: (a) untriaged seeds (parked seeds are only counted, as `parked`), (b) ready-to-resolve seeds, (c) the board's own tasks whose `upstream` seed went terminal → an **idempotent** annotation (`upstream KEY-sN resolved\|rejected: <reason>`, the marker head `upstream <KEY-sN> <resolved\|rejected>` is the machine-recognizable idempotency key) + an unblock **suggestion**. **Writes by default** (running it is the intent); **never transitions**; `--dry-run` previews with no writes. A **report, never a gate** — always **exit 0** (like `doctor`). Format is the `report` split (human in a terminal, `json` piped; `--format json`/`jsonl` for the machine shape — `jsonl` is the composite report on one line, not a per-record stream; `ids` prints the check-(c) task ids). MCP `triage` mirrors 1:1; **the Engine does not serve it** (the report is operator/agent-facing; the console's triage surface is the seeds queue UI, MMR-247). Timer/eventual-consistency mode is **deferred** |
| scratch _(`MMR-331`, ADR 0028)_             | `mimir scratch create\|list\|get\|update\|checkpoint\|agenda add\|complete\|supersede\|freeze\|discard` — the temporary episode-state noun group. Create/list default to the bound project (`-s KEY`; list also accepts `all`); UUID-addressed reads and mutations are global. Create takes no concurrency token and returns a Scratchpad receipt with `updated_at`. Existing-Scratchpad mutations require `--expected-updated-at` and refuse stale values; update, checkpoint, and agenda operations return the next `updated_at` token. Freeze returns an Artifact receipt and discard returns a discard receipt, neither with `updated_at`. `get` alone returns the full Journal + Agenda. `checkpoint` accepts inline content or `--file`; repeated `--link` values replace linked work and `--clear-links` clears it. Freeze is retryable; discard with open Agenda requires `--force --reason`. MCP mirrors these as `scratch_*` tools with `expected_updated_at` and `linked_work`; the Engine's parity is detailed below.                                                                       |
| projects _(`MMR-406`)_                      | `mimir projects [--status active\|archived\|all]` lists projects key-ordered in the set formats (`-f json` wraps rows under `projects`). It ignores the binding scope — projects are the scope dimension — and takes no `-s`. `--status archived` is the sole opt-in to archived projects ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)); MCP mirrors it as the `projects` tool, the Engine as `projects` (`status`). Each row carries `pinned` (`MMR-493`); the listing stays key-ordered, so a client that wants pinned projects first sorts on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| search _(`MMR-447`)_ | `mimir search <query> [-s KEY\|all] [-n 1..100]` finds any record — task, phase, initiative, project, seed, or artifact — by ID, title, or description. An ID query (`mmr-12`, `MMR-s4`, a bare key, or a bare suffix such as `12` or `s4`) returns that record first, then up to eight linked records newest first, each with its `link` label; a bare suffix resolves in the current project, or lists every active project's match when there is none. Other text matches titles holding every term, then descriptions holding every word whole (with a `snippet`); only when neither finds anything do titles holding each term's characters in order match, as a fuzzy fallback for an abbreviation or a typo. The bound project is the current one and ranks first; `-s all` clears it. `-f json` wraps hits under `results` with `returned`, `starts_at`, and `total`; each hit has `kind`, `id`, `project`, `title`, `updated_at`, `lifecycle`, `finished`, `match` (`id`\|`title`\|`description`\|`link`), and `link` or `snippet` only where they apply. For an ID query, `total` counts the record and the links returned. An empty query or a limit outside 1 to 100 is refused, and an unknown current project is not found. MCP mirrors it as the `search` tool (`query`, `scope`, `limit`); the Engine as `console.search` (`query`, `project`, `limit`), returning `{items, total}`. Archived projects never appear. |

The Engine exposes Scratchpad parity through `scratchList` and `scratchGet` and
the matching create, update, checkpoint, agenda, freeze, and discard writes.
Collection rows use `items` plus `total`; detail alone carries the Journal and
Agenda. A list row has the Overview's active-Scratchpad row shape, including
`linked_work`, on the Engine, MCP, and the CLI's structured formats. Every
existing-Scratchpad mutation requires `expected_updated_at`; create takes no
token. `scratchList` scopes one board by `project`.

- **IDs** are `KEY-seq` (nodes) / bare `KEY` (projects), resolved in the transport; **`--parent` is polymorphic** (bare KEY = project; KEY-seq = node). Lists are comma-separated (CLI) / arrays (MCP). MCP mirrors these as **named args** — no positionals, no files/stdin (`content` is a required arg).
- **`create`** takes an explicit type (not inferable from parent). **`attach`** is node-first (infers the owning project) and enforces the **project-consistency rule**: all node refs (primary + links) must share one project, validated _before_ any write.

## Exit codes

Adopted from Norn — keyed to selection mode:

- **Identity selection** (`get`) and **any mutation** → **non-zero** on a missing named target or an invariant violation (a real failure).
- **Predicate selection** (`next` / `list`) → **exit 0 on empty** — a predicate matching nothing is not an error.

**Concrete taxonomy (Phase 3):** coarse `0` / `1` / `2` — `0` success (incl. an empty predicate set) · `2` usage (bad invocation: arg parse, unknown command/flag/value) · `1` operational (any core `MimirError`). The precise category lives **only** in the envelope `code`; the exit status stays coarse. Source = _where_ the failure arises: the transport's arg layer → 2; a core `MimirError` → 1.

## Error rendering (two families)

Errors flow through the same selection→format pipeline as success, but **stream is orthogonal to format**: success → stdout, error → stderr (always); stdout stays empty on failure.

- **Machine (`json` / `jsonl`):** `{"error":{"code","message","hint?"}}`. `hint` present only when remediation is offered.
- **Human (`records` / `table` / `ids`):** the Norn line `✗ <message>` (`[err]` when `--ascii` / `NO_COLOR`) + optional `note: <hint>` line — the glyph carries severity, the code is omitted.
- **MCP:** the same envelope as the `isError` text content (no exit codes).
- **Envelope `code` vocabulary:** `usage · not_found · validation · conflict · invariant` — the four core `MimirError` codes plus the transport-level **`usage`** (CLI-only; the same semantic _invocation_ fault surfaces as `validation` over MCP, which has no `usage`/exit-code concept).

## Help tiers

`-h` terse (synopsis + flags); `--help` fuller, **with usage examples**.

## Resolved (Phase 3)

The former build-time TBDs are settled and implemented (merged 2026-06-05; mimir-build-roadmap Phase 3): the **error envelope** + stream discipline (§Error rendering), the **exit-code taxonomy** (§Exit codes), and the **per-verb argument shapes** (§Verb surface). The intent verb list is the verbs in the Write contract. The CLI `--json` _input_ form was declined (YAGNI) — MCP is the structured-input path; the CLI takes flags/positionals (with stdin for `annotate`/`attach` content only). Known minor debt carried forward: an empty/blank required flag token (e.g. `--on ""`) resolves to `not_found`/exit 1 rather than `usage`/exit 2.

- **Per-format worked examples** for each command.

## Queued run reservations (MMR-564)

`queue <id> --session <run-id>` reserves an unheld todo task. Its harness, host,
branch, and session flags carry the run's handles. `start <id>` accepts a queued
task and replaces those handles with the worker's. `unqueue <id> "reason"`
returns the reservation to todo, clearing handles and logging what was cleared.
Queue and unqueue are also uniform Engine methods and MCP tools; their required
session and reason inputs are validated on every surface. Queued work appears
in `list --status queued`, the console's Now section, and stale hygiene, while
`next` excludes it.
