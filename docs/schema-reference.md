---
title: 'mimir Schema Reference'
status: accepted
date: 2026-07-13
---

# mimir Schema Reference

The concrete shape of the stored model: the tables, columns, and closed vocabularies of the shared SQL store, and the transfer document that carries them between stores. The model is decided across ADRs [0001](decisions/0001-task-status-two-axes-derived-rollup.md)–[0007](decisions/0007-rank-is-primary-order-priority-is-signal.md), extended by seeds ([0020](decisions/0020-seeds-grooming-queue-entity.md)/[0021](decisions/0021-seed-lede-derived-and-capture-grammar.md)), Scratchpads ([0027](decisions/0027-scratchpads-are-temporary-episode-state.md)), and the project archive ([0015](decisions/0015-project-archive-frozen-and-hidden.md)). The store is realized by [ADR 0030](decisions/0030-postgres-store-backend-shared-store-bridge.md) and [ADR 0032](decisions/0032-sqlite-local-tier-shared-sql-store.md). This is a **maintained reference**, not a frozen artifact: it is kept honest as the model moves. The ADRs hold the _why_; this note holds the _shape_.

> **The SQL store is the source of truth.** Mimir keeps work state in one SQL schema with two backends: **SQLite** (the default, one file) and **PostgreSQL** (hosted, shared). The query code is written once; each backend supplies its own DDL and column encodings. The tables and columns below are identical on both. Where this note and the code disagree, the code (`packages/bin/src/core/store-sql/schema.ts` and the two `0001-init` migrations) wins; where an ADR and either disagree, the ADR wins.

## Store conventions

These hold for every table; the per-entity sections below don't repeat them.

- **The stem is the id** ([ADR 0006](decisions/0006-human-readable-node-ids.md)). The primary key of each entity table is the id every surface speaks. There is no surrogate integer id to translate at the boundary, and the primary key makes a duplicate id impossible.

  | Entity                            | Id form   | Table        |
  | --------------------------------- | --------- | ------------ |
  | project                           | `KEY`     | `project`    |
  | work node (initiative/phase/task) | `KEY-seq` | `node`       |
  | artifact                          | `KEY-aN`  | `artifact`   |
  | seed                              | `KEY-sN`  | `seed`       |
  | scratchpad                        | UUID v4   | `scratchpad` |

  `KEY` is two to four uppercase letters (`[A-Z]{2,4}`), immutable, and consumer-supplied. `seq`/`N` are per-project sequence integers, 1-based, with one sequence each for nodes, artifacts, and seeds. A sequence component is never reused. Scratchpads are the deliberate exception to the sequenced identity grammar: their temporary identity is a cryptographically generated UUID v4.

- **Sequences are counters on `project`.** `last_seq`, `last_artifact_seq`, and `last_seed_seq` hold the highest sequence handed out per kind. Allocation increments the counter inside the writing transaction, so two writers never mint one identity twice. An import writes each counter to the highest imported sequence of its kind.

- **Abandon, don't delete.** To retire a task, use its lifecycle (`mimir abandon`). The row and its `KEY-seq` stay, so every reference stays stable ([ADR 0006](decisions/0006-human-readable-node-ids.md)).

- **Absent means unset.** Optional columns are nullable. A null column means "unset", and the reader supplies the documented default (a task's null `hold` reads as `none`). Presence is stored only where it is itself a fact (see [`## Next`](#-next--the-direction-narrative)).

- **Closed vocabularies are database constraints.** Every closed vocabulary carries a `CHECK` built from the `@mimir/contract` enum arrays, so a value outside the set cannot be written (see [Closed vocabularies](#closed-vocabularies)). Foreign keys cover every single-valued reference and primary keys cover every identity. `node.parent_id` is a deferred foreign key, checked at commit, so an import can insert a hierarchy in any order.

- **Timestamps are `text`, never a native timestamp type.** Every instant is a canonical ISO-8601 UTC string with millisecond precision and an explicit `Z` (`2026-08-05T09:30:00.000Z`). That form is an **invariant of the stored value** ([ADR 0029](decisions/0029-caller-zoned-date-semantics.md)): the query paths, the annotation sort, and the transition cursor all compare stored stamps as raw strings, and lexical order tracks chronology only while every value shares one width, one precision, and one zone. A native timestamp round trip would reformat the value and make two exports of the same facts differ. `created_at` is set once; `updated_at` is re-stamped by the core on every write. UTC always: local time is a UI-edge rendering, never stored.

- **Encodings differ by dialect, values do not.** A boolean, a list of text, and a JSON document are stored differently on each backend, and only the dialect's codec reads or writes them:

  | Logical type    | PostgreSQL                         | SQLite                                       |
  | --------------- | ---------------------------------- | -------------------------------------------- |
  | boolean         | `boolean`                          | `integer`, `CHECK` to 0 or 1                 |
  | list of text    | `text[]`                           | `text`, a JSON array                         |
  | JSON document   | `jsonb`                            | `text`, JSON                                 |
  | append-only key | `bigserial`                        | `integer PRIMARY KEY AUTOINCREMENT`          |
  | project key     | `CHECK (key ~ '^[A-Z]{2,4}$')`     | `CHECK` of length 2 to 4 and `NOT GLOB '*[^A-Z]*'` |

  SQLite tables are `STRICT`, so a column holds only its declared type, as PostgreSQL enforces. `AUTOINCREMENT` never reuses an id, so a log's id order stays its append order.

- **Id order is append order for the three logs.** `annotation`, `transition_log`, and `seed_history` carry a surrogate key (`id`), because their insertion order is the fact.

---

## Shape at a glance

- **project** (`project`) — the scope root and allocation authority. Carries the immutable `key`. Doesn't complete, isn't ranked, has no parent. May carry a `## Next` direction narrative.
- **work node** (`node`) — the typed adjacency tree (`initiative | phase | task`), one table with type-gated columns. Only **tasks** carry status (`lifecycle`/`hold`) and `rank`.
- **dependency** (`dependency`) — a node's prerequisites, one row per edge. `blocked`/`ready`/`blocking` are _derived_ from these, never stored.
- **annotation** (`annotation`) — freeform in-flight notes on a node.
- **transition / history** (`transition_log`) — the append-only log ([ADR 0003](decisions/0003-append-only-transition-log.md)), keyed to a node or (for `archive`) a project.
- **artifact** (`artifact`, `artifact_link`) — frozen markdown blob, anchored to one project, linked to 0..N nodes ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)).
- **seed** (`seed`, `seed_history`) — the grooming-queue record ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)): project-anchored, its own `KEY-sN` id, **not** a node.
- **scratchpad** (`scratchpad`) — temporary, project-anchored episode state ([ADR 0027](decisions/0027-scratchpads-are-temporary-episode-state.md)), with an append-only numbered Journal and lifecycle-owned numbered Agenda. It freezes into a complete Artifact or is discarded; it is not a node or mutable Artifact.
- **tag** (`tag`) — an opaque string applied to a project, node, or artifact ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)); seeds carry no tags. The store keeps **no per-tag note or timestamp**.
- **schema_version** — which schema the database carries (see [Schema version and migrations](#schema-version-and-migrations)).

---

## `project`

The scope root. Categorically not a node: it doesn't complete (no status), isn't ordered (no rank), has no parent. Workspace grouping is a **tag** (`workspace:*`), not a foreign key ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)) — there is no `workspace_id`. The core model and Store seam know **no repo checkout paths** ([ADR 0011](decisions/0011-repo-binding-is-repo-side.md)); the repo→project binding lives repo-side in a checked-in `.mimir.toml`.

| Column              | Type    | Null     | Allowed / default                                                                         |
| ------------------- | ------- | -------- | ----------------------------------------------------------------------------------------- |
| `key`               | text    | primary  | `[A-Z]{2,4}`, immutable                                                                   |
| `name`              | text    | required | display name                                                                              |
| `description`       | text    | optional | free text                                                                                 |
| `archived_at`       | text    | optional | set = archived, null = active ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)) |
| `last_seq`          | integer | required | node sequence counter, default 0                                                          |
| `last_artifact_seq` | integer | required | artifact sequence counter, default 0                                                      |
| `last_seed_seq`     | integer | required | seed sequence counter, default 0                                                          |
| `next_present`      | boolean | required | whether the `## Next` narrative is set, default false                                     |
| `next_text`         | text    | optional | the narrative prose                                                                       |
| `created_at`        | text    | required | ISO-8601 UTC                                                                              |
| `updated_at`        | text    | required | ISO-8601 UTC, every write                                                                 |

Project-keyed `archive`/`unarchive` transitions ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)) append to `transition_log` with `project_key` set. Projects carry no annotations.

## `node` (initiative | phase | task)

One table absorbs the semi-regular hierarchy (a monorepo sub-project, a phaseless initiative, a spec-less task). Type-specific columns are **type-gated**: the writer sets them only for the owning type, and the reader reads them only for it, so a stray value on the wrong type never projects. `parent_id` null means top-level under the project (a root); it is never a bare project `KEY`. `(project_key, seq)` is unique.

| Column         | Type    | Applies to                    | Allowed / default                                                                                   |
| -------------- | ------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `id`           | text    | all, primary                  | `KEY-seq`                                                                                           |
| `project_key`  | text    | all, required                 | foreign key to `project.key`                                                                        |
| `type`         | text    | all, required                 | `initiative` \| `phase` \| `task` (immutable)                                                       |
| `parent_id`    | text    | all, optional                 | foreign key to `node.id`, deferred; **null = top-level root**                                       |
| `seq`          | integer | all, required                 | the node's per-project sequence                                                                     |
| `title`        | text    | all, required                 | free text                                                                                           |
| `description`  | text    | all, optional                 | the node's prose; uncapped. Only the short `summary` lede has a length limit                         |
| `summary`      | text    | all, optional                 | the short list lede; the write verbs reject over 256 chars                                          |
| `lifecycle`    | text    | **task**; set by the writer   | `todo` \| `in_progress` \| `under_review` \| `done` \| `abandoned`                                  |
| `hold`         | text    | **task**, optional            | `none` \| `blocked` \| `parked`; null reads as `none`                                               |
| `hold_reason`  | text    | **task**, optional            | context for the current hold (the transition reason itself rides `transition_log`)                  |
| `priority`     | text    | **task**, optional            | `p0` \| `p1` \| `p2` \| `p3`; null = **untriaged**                                                  |
| `size`         | text    | **task**, optional            | `small` \| `medium` \| `large`; null = **unsized**                                                  |
| `rank`         | integer | **task**, optional            | relative order, core-owned & never surfaced; null outside the rankable set                          |
| `external_ref` | text    | **task**, optional            | outward GitHub issue/PR ref                                                                         |
| `upstream`     | text    | **task**, optional            | `KEY-sN` seed pointer, reference-only ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md))   |
| `host`         | text    | **task**, optional            | resume handle — the machine the work is happening on                                                |
| `harness`      | text    | **task**, optional            | resume handle — the agent harness running it                                                        |
| `session`      | text    | **task**, optional            | resume handle — the session id to resume from                                                       |
| `branch`       | text    | **task**, optional            | resume handle — the branch the work lives on                                                        |
| `completed_at` | text    | **task**, optional            | stamped only on `done`                                                                              |
| `target`       | text    | **phase**, optional           | the milestone/testable result the phase aims at                                                     |
| `open_ended`   | boolean | **container**, optional       | opts a phase/initiative out of done-rollup; null = not set                                          |
| `next_present` | boolean | all, default false             | whether the `## Next` narrative is set; only containers carry one                                   |
| `next_text`    | text    | **container**, optional       | the narrative prose                                                                                 |
| `created_at`   | text    | all, required                 | ISO-8601 UTC                                                                                        |
| `updated_at`   | text    | all, required                 | ISO-8601 UTC, every write                                                                           |

Indexes cover `parent_id` and `project_key`.

**Status is two stored axes, and only on tasks** ([ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md)): `lifecycle` (pure progress) and `hold` (the `none|blocked|parked` overlay). Phases and initiatives store **no** status — their truth is the live distribution over children, derived, never a column.

**`rank`** is the relative order ([ADR 0007](decisions/0007-rank-is-primary-order-priority-is-signal.md)), an integer-with-gaps that is **never returned to consumers** — re-spreading preserves order while changing integers. It is set only for a task in the **rankable set** (`lifecycle ∈ {todo, in_progress} ∧ hold = none`); the lifecycle/hold verbs set it on entry (append-to-bottom) and clear it on exit, and `reorder` moves it.

**`priority` / `size` are nullable signals, by design** — null means _untriaged / unsized_, a real surfaceable state. The core forces no default; a consumer may impose one. Both are coarse: they filter and advise `rank`, never order it.

**`host` / `harness` / `session` / `branch` are resume handles, not telemetry** ([ADR 0026](decisions/0026-work-state-composition.md) Decision 3). They answer three forensic questions — what is happening, what did happen, how do I continue — and nothing else: anything recoverable _from_ the session (model, durations, token counts) stays out, because Mimir stores the keys into richer stores and mining happens there. They are free strings on the update plane, so `start` records them as the claim (CLI `--host/--harness/--session/--branch`, the same args on MCP and HTTP) and a plain `update` overwrites them — **there is no claim verb**: `in_progress` already is the claim, and `start`'s CAS-guarded `todo→in_progress` assert already makes claiming atomic, so resume and takeover are ordinary patches (a blank clears one). The lifecycle verbs clear all four on the terminal transitions (`done`, `abandon`) and on the holds (`park`, `block`) — held or settled work is not in flight, and a stale pointer is worse than an absent one — but **keep** them through `submit`/`under_review` and `return`, where the branch and session are still the live pointers at the human gate. `reopen`/`unpark`/`unblock` restore nothing; a resuming agent re-states them. Absence is always legitimate, so nothing detects, defaults, or repairs a missing handle, and Mimir makes no liveness claim: consumers judge from the handles, with the `stale` predicate as the coarse backstop. PR linkage rides `external_ref`, not these.

## `dependency`

A node's prerequisites, one row per edge: `(node_id, depends_on_node_id)`, both foreign keys to `node.id`, primary key over the pair. `node → depends_on` means the node waits on that prereq. A `CHECK` refuses a self-edge. `blocked`, `awaiting`, `blocking`, and `ready` are all _derived_ from these edges (design §4), never stored. Tasks are the common case; initiative→initiative prerequisites use the same table. Each add/remove also writes a `dependency` row to `transition_log`.

Cycles are refused by the write path, not by a constraint. `mimir doctor` reports a dangling edge (a missing endpoint) if a constraint was dropped by hand.

## `transition_log` — the transition log

The append-only history ([ADR 0003](decisions/0003-append-only-transition-log.md)), written **in the same transaction** as the state change, by the same verb, so the state and the log can't drift.

| Column        | Type    | Null     | Allowed / default                                                                 |
| ------------- | ------- | -------- | --------------------------------------------------------------------------------- |
| `id`          | key     | primary  | auto-incrementing; id order is append order                                       |
| `node_id`     | text    | optional | foreign key to `node.id`; set for node-keyed rows                                 |
| `project_key` | text    | optional | foreign key to `project.key`; set for `archive` rows                              |
| `kind`        | text    | required | `lifecycle` \| `hold` \| `dependency` \| `move` \| `archive`                      |
| `from_value`  | text    | optional | the edge's old side                                                               |
| `to_value`    | text    | optional | the edge's new side                                                               |
| `reason`      | text    | optional | the transition reason                                                             |
| `handles`     | JSON    | optional | the resume handles the transition moved, as an object                             |
| `at`          | text    | required | ISO-8601 UTC                                                                      |

A `CHECK` requires exactly one of `node_id` and `project_key`. `archive` is **project-keyed** ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)); the other kinds are node-keyed.

- **The edge** is the sole change carrier. A two-sided change fills `from_value` and `to_value` (lifecycle/hold/move/archive). A one-sided edge change fills only `to_value` when an edge was added, or only `from_value` when one was removed (`dependency`). A change with neither side leaves both null.
- **`reason`** is the home of transition **reasons** — an abandon/park/block reason rides its row, beside the state change it explains, not in an annotation.
- **The resume-handle echo** ([ADR 0026](decisions/0026-work-state-composition.md) Decision 3): a transition that _moves_ the handles records them in `handles`. `start` records **the claim state at the transition** (what the task carries once claimed — including a handle pre-seeded at `create`, not only what its own flags stamped); the clearing transitions (`done`/`abandon`, `park`/`block`) record what they cleared. Claim succession therefore survives in the append-only log. `handles` is null when no handle moved.

Indexes cover `(node_id, id)`, `(at, id)`, and `(project_key, id)`. Derived flip-times (`became_ready_at`, `recently_completed`) are computed from this feed against a caller-supplied cursor, **never stored**.

## `annotation`

Freeform in-flight notes on a node — the lightweight middle ground between a node's description and a heavy session-log artifact. Each row has an auto-incrementing `id` (append order), the owning `node_id` (foreign key), `content`, and `created_at`. There is no kind and no edge. Appended by `annotate`. Nodes only — projects carry no annotations. Transition reasons do **not** live here (they ride `transition_log.reason`). Indexed on `node_id`.

## `## Next` — the direction narrative

The one **owned prose surface above task granularity** ([ADR 0026](decisions/0026-work-state-composition.md) Decision 2). What to work on next is derived (ready ∩ rank) and is never stored; the non-derivable residue — the editorial statement of where a project or container is headed — lives in the `next_present` / `next_text` column pair on a **project**, **initiative**, or **phase** row. Tasks carry none: a task's prose homes are `description` and annotations.

`next_present` is a stored fact the prose cannot carry. An absent narrative and an empty one are different stored states (`next_present` false versus true with null text), and the transfer document preserves the distinction. Every projection omits the field when it is unset.

**Replace-not-append.** `update <id> --direction "<text>"` (CLI; `next` on MCP and HTTP) re-authors the **whole** narrative — there is no append grain, which is precisely what kept hand-maintained work-state sections growing monotonically. A blank value **clears** it. The write rides the ordinary CAS-guarded update and co-stamps `updated_at`; re-authoring the identical text writes nothing at all, so the stale clock doesn't move on a no-op. A concurrent write that drifts the row refuses on that CAS — the writer re-reads and re-authors against the current board rather than replaying a stale draft. The narrative is set only through `update`: `create` refuses `--direction` (and the HTTP create body rejects a stray `next`) rather than accepting prose it would discard.

The prose is **uncapped**. Reads: `get KEY` / `get KEY-seq` carry it by default, and `--col next` names it explicitly. Bulk paths (`list`, `next`, `tree`) pass their own facet lists and exclude it.

## `artifact` and `artifact_link`

A frozen markdown document — not diffed or edited in place, only ever added to. **Anchored to exactly one project** (required); **linked to 0..N nodes** through `artifact_link` (optional context) ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)). No `type` classification enum and no `consolidated_at`: `spec`/`plan`/`session_log` and consolidation state are **tags** ([ADR 0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)/0004). Correct a bad artifact by attaching a new one.

| Column           | Type | Null     | Allowed / default                                                    |
| ---------------- | ---- | -------- | -------------------------------------------------------------------- |
| `id`             | text | primary  | `KEY-aN`                                                             |
| `project_key`    | text | required | foreign key to `project.key`                                         |
| `seq`            | int  | required | per-project artifact sequence; `(project_key, seq)` is unique        |
| `title`          | text | required | display title                                                        |
| `summary`        | text | optional | ≤256-char lede, newlines collapsed                                   |
| `content`        | text | required | the frozen markdown, stored without a trailing newline               |
| `source_scratch` | text | optional | canonical Scratchpad UUID; freeze provenance. No foreign key         |
| `created_at`     | text | required | ISO-8601 UTC                                                         |
| `updated_at`     | text | required | ISO-8601 UTC; metadata mutations only                                |

`artifact_link` holds `(artifact_id, node_id)`, both foreign keys, primary key over the pair, with an index on `node_id` for a node's artifacts. A link names a node in the artifact's own project; the write path enforces the **project-consistency rule** before any write.

`summary` is the artifact's optional lede — the same field a node carries, with the same 256-character cap and the same core normalization (newlines collapse to spaces, a blank stores as null). With `title` it makes the artifact's two mutable fields; `content` stays frozen. `updated_at` tracks **metadata** mutations only (retitle, re-lede, tag/untag): it is the CAS drift guard those writes co-stamp, exactly like the node, project, and seed write paths. Like every entity, artifacts **carry no tag notes** (ADR 0005 Refinement).

## `seed` and `seed_history`

The grooming-queue record ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)/[0021](decisions/0021-seed-lede-derived-and-capture-grammar.md)): project-anchored, its own `KEY-sN` id, **not** a node. A seed's lifecycle is triage progress, and both `kind` and `lifecycle` are **required closed columns**, not tags (the feature interprets them, so [ADR 0005](decisions/0005-grouping-axis-is-tags.md) does not apply).

| Column        | Type      | Null     | Allowed / default                                                         |
| ------------- | --------- | -------- | ------------------------------------------------------------------------- |
| `id`          | text      | primary  | `KEY-sN`                                                                  |
| `project_key` | text      | required | foreign key to `project.key`; the anchoring project                       |
| `seq`         | integer   | required | per-project seed sequence; `(project_key, seq)` is unique                 |
| `title`       | text      | required | display title                                                             |
| `kind`        | text      | required | `idea` \| `bug` \| `feature`                                              |
| `lifecycle`   | text      | required | `new` \| `promoted` \| `resolved` \| `rejected`; starts `new`             |
| `requester`   | text      | optional | `KEY` of a requesting project. No foreign key                             |
| `description` | text      | optional | the prose body (the lede is derived from it, ADR 0021)               |
| `spawned`     | text list | required | `KEY-seq` work nodes germinated from this seed; default empty             |
| `created_at`  | text      | required | ISO-8601 UTC                                                              |
| `updated_at`  | text      | required | ISO-8601 UTC, every write                                                 |

`seed_history` holds a seed's lifecycle transitions: `id` (append order), `seed_id` (foreign key), `kind` (the transition vocabulary), `from_value`, `to_value`, `reason`, and `at`. Seed transitions are **not** in `transition_log`: that feed is keyed to nodes and projects (ADR 0015).

**Lifecycle machine:** `new → promoted | resolved | rejected` and `promoted → resolved | rejected`. `resolved`/`rejected` are terminal (a terminal seed is frozen — `patch`/`transition` refuse it); the terminal states are set only by explicit triager verbs, never derived from spawned work. `promote`/germinate moves `new → promoted` and appends the spawned node to `spawned` in one transaction.

The task-side `upstream` column (see the node table) is the requester-side pointer at a seed — reference-only in v1, resolved by the read seam.

`seed_history` is indexed on `(seed_id, id)`.

## `scratchpad`

A Scratchpad is temporary, project-anchored state for one unsettled work episode ([ADR 0027](decisions/0027-scratchpads-are-temporary-episode-state.md)). Its id is a canonical lowercase UUID v4 generated by the runtime. The storage seam accepts exact UUIDs only; any human-facing prefix convenience belongs above it.

| Column        | Type      | Null     | Allowed / default                                        |
| ------------- | --------- | -------- | -------------------------------------------------------- |
| `id`          | text      | primary  | UUID v4                                                  |
| `project_key` | text      | required | foreign key to `project.key`, the one required home      |
| `title`       | text      | required | display title                                            |
| `anchors`     | text list | required | same-project linked-work ids; default empty. No foreign key |
| `journal`     | JSON      | required | the Journal entries, an array                            |
| `agenda`      | JSON      | required | the Agenda items, an array                               |
| `freezing_at` | text      | optional | set while the idempotent freeze protocol runs            |
| `created_at`  | text      | required | canonical ISO-8601 UTC milliseconds                      |
| `updated_at`  | text      | required | canonical ISO-8601 UTC milliseconds                      |

`created_at <= updated_at` is the only relational timestamp invariant. Journal timestamps use the same canonical representation, but their numbering — not wall-clock order — is authoritative; they need not be monotonic or equal `updated_at`. A row with `freezing_at` set remains readable so the service can recover an interrupted freeze.

The service validates supplied anchors on create and metadata update, and before freeze stages a pad. Anchors must name existing work nodes in the same project. Because `anchors` is a list column with no foreign key, the database does not enforce this, and `mimir doctor` checks anchors. A staged pad with invalid anchors can clear or replace them only when no source Artifact exists. This guarded update clears `freezing_at` and advances `updated_at`. Other staged pads remain locked for freeze retry.

`journal` and `agenda` are JSON arrays. Their local number spaces are independent, start at 1, and remain contiguous and monotonic:

```json
{
  "journal": [{ "number": 1, "at": "2026-08-01T20:44:00.000Z", "content": "Freeform checkpoint prose." }],
  "agenda": [
    { "number": 1, "state": "open", "content": "Open question", "reason": null },
    { "number": 2, "state": "done", "content": "Settled question", "reason": null },
    { "number": 3, "state": "superseded", "content": "Superseded question", "reason": "replaced by agenda 7" }
  ]
}
```

Journal entries are append-only free Markdown. Agenda supports only add (`open`), complete (`done`), and supersede with a required reason (`superseded`). Reopening or deleting an item is not a transition; a revived concern gets a new number referencing the old item. The Agenda states are the closed vocabulary `open | done | superseded`.

## `tag`

The whole grouping axis and classification layer ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)/[0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)) is one table of opaque strings on any project, node, or artifact — `workspace:*` on projects, `release:*` on tasks, `spec`/`consolidated` classification, all uniform. Seeds do **not** carry tags: their classification (`kind`) and triage state (`lifecycle`) are intrinsic closed columns. The core does set-membership filtering composed with structural scope (`project = X AND has(tag)`) and **never parses** the string.

A row is `(entity_type, entity_id, tag)` with the whole triple as the primary key. `entity_type` is `project`, `node`, or `artifact`, and `entity_id` is a project key or an artifact or node id. `entity_id` has no foreign key, because it points into three tables.

The store keeps **only the string**: there is **no per-tag note and no per-tag timestamp**. **A tag application carries no note on any entity** ([ADR 0005](decisions/0005-grouping-axis-is-tags.md) Refinement): membership is the whole signal, and note-intent routes to annotations (one-off rationale) or a tagged artifact (shared grouping metadata). The read path synthesizes a tag's `created_at` from the owning entity's own `created_at`. Removing a tag is a plain, unlogged delete (`untag`).

---

## Closed vocabularies

Each is a `CHECK` on its column, built from the enum arrays in `@mimir/contract`. A value outside the set cannot be written. Widening a vocabulary is a migration.

| Column                                  | Values                                                     |
| --------------------------------------- | ---------------------------------------------------------- |
| `node.type`                             | `initiative`, `phase`, `task`                              |
| `node.lifecycle`                        | `todo`, `in_progress`, `under_review`, `done`, `abandoned` |
| `node.hold`                             | `none`, `blocked`, `parked`                                |
| `node.priority`                         | `p0`, `p1`, `p2`, `p3`                                     |
| `node.size`                             | `small`, `medium`, `large`                                 |
| `transition_log.kind`, `seed_history.kind` | `lifecycle`, `hold`, `dependency`, `move`, `archive`    |
| `seed.kind`                             | `idea`, `bug`, `feature`                                   |
| `seed.lifecycle`                        | `new`, `promoted`, `resolved`, `rejected`                  |
| `tag.entity_type`                       | `project`, `node`, `artifact` (seeds carry no tags)        |
| `project.key`                           | two to four uppercase letters                              |

`node.open_ended` is a boolean, and the Agenda item state (`open`, `done`, `superseded`) lives inside the `agenda` JSON, so the application validates it rather than a `CHECK`.

The **status word** vocabulary (`ready`, `awaiting`, `blocked`, `parked`, `in_progress`, `under_review`, `done`, `abandoned`, and `new` for empty containers — [ADR 0008](decisions/0008-state-word-projection-and-interpret-cascade.md)) is a **derived projection**, not a stored column.

## Derived — never stored

Query-layer outputs, intentionally **absent** from every table ([ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md)/[0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md), design §4–5). Storing any of these reintroduces the sync surface Mimir exists to remove:

- **Predicates:** `ready`, `awaiting`, `blocked`, `blocking`, `stale`, `orphaned`.
- **Rollup:** a non-leaf node's status **distribution** (`{done:3, ready:1}`) and its `interpret()` status word — computed live over direct children, never cached.
- **Transition cursors:** `newly_ready`, `recently_completed` (a caller cursor over `transition_log`); `unconsolidated` (a tag query).
- **Flip-times / presentation:** `became_ready_at`, the seed lede.

## Schema version and migrations

`schema_version` holds `(version, applied_at)`, one row per applied migration. The store's version is the highest `version` present. A fresh database has no `schema_version` table.

Migrations are a static, ordered list carried in the binary (`core/store-sql/migrations.ts`), forward-only: append, never edit, because a migration that has run on any store is a historical fact. Each migration's DDL is written as literal statements once per dialect, so a migration cannot be added for one backend alone. The first migration is `0001_init`, which creates every table above. Each migration runs in its own transaction, so a failed step leaves the old schema intact.

- **Newer schema than the binary.** Every normal command refuses it, on both backends. A newer schema is never downgraded; update the binary.
- **SQLite migrates on open.** The store is one file, `store.sqlite`, in the installation's data directory. Opening creates it when absent, runs it in WAL mode with foreign keys enforced, and applies every pending migration. A file that holds tables but no schema version is refused as not a Mimir store, and the file is left as found.
- **PostgreSQL migrates only on `mimir store upgrade`.** A fresh database has no schema, and every other command refuses until the version matches the binary exactly, in either direction. The upgrade runs under a lock so two machines upgrading at once serialize, and it re-reads the version inside the lock so the loser applies nothing. See the [Postgres store guide](guides/postgres-store.md).

`/api/health` reports `schema` as the schema version this binary expects. `mimir doctor` reports a `schema-version` finding when the database's version differs. On Postgres that is a normal rollout state — one machine has run `store upgrade` and another has not — not a hand edit.

## Transfer document

`mimir store export <file>` writes the whole store as one JSON document, and `mimir store import <file>` reads it. It is the **portable form** of the store: backend-neutral, so it moves facts between SQLite and PostgreSQL, and it is the backup for either ([ADR 0030](decisions/0030-postgres-store-backend-shared-store-bridge.md) Decision 4, [ADR 0032](decisions/0032-sqlite-local-tier-shared-sql-store.md) Decisions 5 and 6). A store from a Norn vault enters the same way: export it with mimir v0.20, then import the document (see [Moving from a Norn vault](guides/postgres-store.md#moving-from-a-norn-vault)).

The document carries every **stored fact** and nothing derived. Its top level holds `schema_version` (the document's own version, separate from the database schema version), `exported_at` (the only field a re-export may differ in), and these collections:

| Collection     | Holds                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| `projects`     | every project, archived included, with its three sequence `counters`                      |
| `nodes`        | every node                                                                                |
| `edges`        | the dependency edges                                                                      |
| `tags`         | project and node tag applications (an artifact's tags ride its own record)                |
| `annotations`  | node annotations                                                                          |
| `artifacts`    | artifacts with frozen `content`, `source_scratch`, tags, and links                        |
| `seeds`        | seeds with `description` and their own `history`                                          |
| `scratchpads`  | scratchpads, whole                                                                        |
| `bodySections` | the owned prose of projects and nodes: `description` and the `next` narrative with its presence |
| `transitions`  | the `transition_log` rows, with their resume handles                                      |

Identity is preserved: every `KEY`, `KEY-seq`, `KEY-aN`, and `KEY-sN`, every timestamp, and the counters. Set-valued fields (tags, links) are written in one canonical order, and transitions in one canonical order, so two stores holding the same facts export byte-identical documents (apart from `exported_at`).

Export is **fail-closed**: it refuses, and names the records, when the store holds something the document cannot carry, so a backup is never quietly narrower than the store. Import validates the whole document before it touches the target. The preview and the apply run the same transaction, and the preview rolls it back. See the [Postgres store guide](guides/postgres-store.md#back-up) for the operator workflow.

## Constraints and diagnostics

The database enforces what a tolerant reader once had to diagnose: a foreign key for every single-valued reference, a primary key for every identity, and a `CHECK` over each closed vocabulary. `tag.entity_id`, `scratchpad.anchors`, `seed.spawned`, `seed.requester`, and `artifact.source_scratch` carry no foreign key. A record that fails a constraint cannot be written. `mimir doctor` therefore reports a short list on either backend: a schema version mismatch, a dangling parent or dependency reference, a sequence counter behind its rows, and an orphan artifact link or scratchpad anchor. It has no repair pass, and `doctor --fix` is refused. The findings a rollout cannot produce — a dangling reference, a counter behind its rows, an orphan link — point at a hand edit of the database.

## Status

The schema is **settled and maintained**: the tables, the value sets, and the timestamp format above are the shape the store's read and write paths are built from. It moves with the model — a schema-affecting change adds a migration and updates this reference in step.
