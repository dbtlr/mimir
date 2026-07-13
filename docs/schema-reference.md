---
title: 'mimir Schema Reference'
status: accepted
date: 2026-07-13
---

# mimir Schema Reference

The concrete shape of the model — realized as the vault's **markdown frontmatter and body sections** — decided across ADRs [0001](decisions/0001-task-status-two-axes-derived-rollup.md)–[0007](decisions/0007-rank-is-primary-order-priority-is-signal.md), extended by seeds ([0020](decisions/0020-seeds-grooming-queue-entity.md)/[0021](decisions/0021-seed-lede-derived-and-capture-grammar.md)) and the project archive ([0015](decisions/0015-project-archive-frozen-and-hidden.md)). This is a **maintained reference**, not a frozen artifact: the vault's frontmatter and Norn's handling of it are built from here, and this document is kept honest as the model moves. The ADRs hold the _why_ in full; this note holds the _shape_ plus enough prose to construct valid Norn documents without re-deriving the contract from code.

> **Single source of truth is the vault.** The durable record is the markdown itself — hand-editable, git-backed, inspectable. Norn ([ADR 0016](decisions/0016-norn-vault-system-of-record.md)) owns every read, write, and query and maintains its own SQLite **index**; that index is a cache, never the record. Mimir reduces to business logic and derivation over Norn ([ADR 0018](decisions/0018-vault-access-is-norn-only.md): **all vault access is Norn-only** — Mimir never touches files directly). Where this note and a document disagree, the document wins; where an ADR and either disagree, the ADR wins.

This reference replaces the pre-cutover SQLite DDL: post-[MMR-234](decisions/0016-norn-vault-system-of-record.md) there is **no database of record** and **no surrogate integer id** — the SQLite backend, its schema, and its migrations are gone. Each entity is a markdown document whose **file stem is its id**; the integers the reader mints are synthetic, stable only within one load, and never cross a surface or persist.

## Vault conventions

These hold for every document; the per-entity sections below don't repeat them.

- **The stem is the id** ([ADR 0006](decisions/0006-human-readable-node-ids.md)). A document's identity is its filename stem, spoken by every surface:

  | Entity                            | Id form   | Document path             |
  | --------------------------------- | --------- | ------------------------- |
  | project                           | `KEY`     | `KEY/KEY.md`              |
  | work node (initiative/phase/task) | `KEY-seq` | `KEY/KEY-seq.md`          |
  | artifact                          | `KEY-aN`  | `KEY/artifacts/KEY-aN.md` |
  | seed                              | `KEY-sN`  | `KEY/seeds/KEY-sN.md`     |

  `KEY` is `[A-Z]{2,4}`, immutable, consumer-supplied. `seq`/`N` are per-project sequence integers, **derived** as `max(seq)+1` over the project's documents at create time (create-exclusive: a colliding path re-derives and retries) — there is **no stored allocation counter** ([ADR 0016](decisions/0016-norn-vault-system-of-record.md)). A seq is never reused while a document exists.

- **Relations are Obsidian wikilinks.** `project`, `parent`, `depends_on`, `anchor`, `requester`, and `spawned` are written as `[[STEM]]` (or `[[STEM|alias]]`); Norn collapses the brackets in field matching, so `vault.find --eq project:KEY` resolves them. The reader de-aliases and collapses to the bare stem. `upstream` and `external_ref` are **plain scalars**, not wikilinks.

- **Omit-when-empty.** Only the identity/type/timestamp fields are always present. Every other field is written **only when it has a value**; an absent field means "unset," and the reader supplies the documented default (a task's absent `hold` → `none`). A deliberate neutral value (`hold: none`) is written as absence.

- **Closed vocabularies are validator-enforced, not vault-enforced.** Norn has no enum/boolean field type, so value legality can't be checked at the vault layer ([ADR 0016](decisions/0016-norn-vault-system-of-record.md) sketched write-time value enforcement in Norn; the implementation landed it validator-side per [ADR 0017](decisions/0017-runtime-data-tolerance.md)'s tolerance model). The shared graph validator ([ADR 0017](decisions/0017-runtime-data-tolerance.md), consumed by both the tolerant reader and `mimir doctor`) is the guard: it drops or nulls out-of-vocabulary values (see [Closed vocabularies](#closed-vocabularies)). `open_ended` booleans serialize as the strings `'true'`/`'false'`.

- **Timestamps** are `TEXT`, ISO-8601, UTC, millisecond precision with an explicit `Z` — human-readable, and lexically = chronologically sortable. The **creation** timestamp's frontmatter key is `created` (not `created_at`); the mutation/completion/archive stamps keep their `_at` suffix: `updated_at`, `completed_at`, `archived_at`. `created` is set once; `updated_at` is re-stamped by the core on every write. UTC always — local time is a UI-edge rendering, never stored.

---

## Shape at a glance

- **project** (`KEY/KEY.md`) — the scope root and allocation authority. Carries the immutable `key`. Doesn't complete, isn't ranked, has no parent. Body: `## History` only.
- **work node** (`KEY/KEY-seq.md`) — the typed adjacency tree (`initiative | phase | task`), one document shape with type-gated fields. Only **tasks** carry status (`lifecycle`/`hold`) and `rank`. Body: `## Task Description`, `## History`, `## Annotations`.
- **dependency** — not its own document: a node's prerequisites are the `depends_on` wikilink list in **its own** frontmatter. `blocked`/`ready`/`blocking` are _derived_ from these, never stored.
- **annotation** — not its own document: freeform in-flight notes are `## Annotations` records in the node's body.
- **transition / history** — not its own document: the append-only log ([ADR 0003](decisions/0003-append-only-transition-log.md)) is `## History` records in the node's (or project's, for `archive`) body.
- **artifact** (`KEY/artifacts/KEY-aN.md`) — frozen markdown blob, anchored to one project, linked to 0..N nodes via the `anchor` field ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)).
- **seed** (`KEY/seeds/KEY-sN.md`) — the grooming-queue record ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)): project-anchored, its own `KEY-sN` id, **not** a node. Body: `## Seed Description`, `## History`, `## Annotations`.
- **tag** — not its own document: an opaque string in the `tags` frontmatter list on any project/node/artifact ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)); seeds carry no tags. The vault stores **no per-tag note or timestamp**.

---

## `project` — `KEY/KEY.md`

The scope root. Categorically not a node: it doesn't complete (no status), isn't ordered (no rank), has no parent. Workspace grouping is a **tag** (`workspace:*`), not an FK ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)) — there is no `workspace_id`. The store knows **no filesystem paths** ([ADR 0011](decisions/0011-repo-binding-is-repo-side.md)); the repo→project binding lives repo-side in a checked-in `.mimir.toml`.

| Field         | Type           | Presence | Allowed / default                                                                                 | Written by                  |
| ------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| `type`        | string         | always   | `project`                                                                                         | `create project`            |
| `key`         | string         | always   | `[A-Z]{2,4}`, immutable                                                                           | `create project`            |
| `name`        | string         | always   | display name                                                                                      | `create project` / `update` |
| `project`     | wikilink       | always   | `[[KEY]]` (self-referential; the query-scope handle for `find --eq project:KEY`)                  | `create project`            |
| `created`     | timestamp      | always   | ISO-8601 UTC                                                                                      | `create project`            |
| `updated_at`  | timestamp      | always   | ISO-8601 UTC                                                                                      | every write                 |
| `description` | string         | optional | free text                                                                                         | `create project` / `update` |
| `archived_at` | timestamp      | optional | set = archived, absent = active ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)) | `archive` / `unarchive`     |
| `tags`        | list of string | optional | opaque strings                                                                                    | `tag` / `untag`             |

**Body:** `## History` only (projects carry no `## Annotations`). Project-keyed `archive`/`unarchive` transitions ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)) append here.

There is **no `last_seq` / `last_artifact_seq`** in the vault — these were allocation counters of the retired backend; seq is now derived over the vault ([ADR 0016](decisions/0016-norn-vault-system-of-record.md)).

## `node` — `KEY/KEY-seq.md` (initiative | phase | task)

One document shape absorbs the semi-regular hierarchy (a monorepo sub-project, a phaseless initiative, a spec-less task). Type-specific fields are **type-gated**: the writer emits them only for the owning type, and the reader reads them only for it, so a stray value on the wrong type never projects. The rendered id `KEY-seq` is the stem; `project` and `parent` are wikilinks. `parent` **absent** means top-level under the project (a root); it is never a bare project `KEY`.

| Field          | Type             | Presence                           | Allowed / default                                                                                 | Written by                            |
| -------------- | ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `type`         | string           | always                             | `initiative` \| `phase` \| `task` (immutable)                                                     | `create`                              |
| `title`        | string           | always                             | free text                                                                                         | `create` / `update`                   |
| `project`      | wikilink         | always                             | `[[KEY]]` (query-scope handle; the authoritative project is the stem)                             | `create`                              |
| `created`      | timestamp        | always                             | ISO-8601 UTC                                                                                      | `create`                              |
| `updated_at`   | timestamp        | always                             | ISO-8601 UTC                                                                                      | every write                           |
| `summary`      | string           | optional (all types)               | the short list lede — free string in the vault; the write verbs reject over 256 chars             | `create` / `update`                   |
| `parent`       | wikilink         | optional (all types)               | `[[KEY-seq]]`; **absent = top-level root**                                                        | `create` (initial placement) / `move` |
| `depends_on`   | list of wikilink | optional (all types)               | `[[KEY-seq]]` prereq stems (see [Dependencies](#dependencies))                                    | `depend` / `undepend`                 |
| `tags`         | list of string   | optional (all types)               | opaque strings                                                                                    | `tag` / `untag`                       |
| `lifecycle`    | string           | **task** (required)                | `todo` \| `in_progress` \| `under_review` \| `done` \| `abandoned`                                | lifecycle verbs                       |
| `hold`         | string           | **task**, optional                 | `blocked` \| `parked`; **`none` omitted** (absent → `none`)                                       | `park`/`unpark`, `block`/`unblock`    |
| `hold_reason`  | string           | **task**, optional                 | context for the current hold (the transition reason itself rides `## History`)                    | `park` / `block` (cleared on unhold)  |
| `priority`     | string           | **task**, optional                 | `p0` \| `p1` \| `p2` \| `p3`; absent = **untriaged**                                              | `create` / `update`                   |
| `size`         | string           | **task**, optional                 | `small` \| `medium` \| `large`; absent = **unsized**                                              | `create` / `update`                   |
| `rank`         | integer          | **task**, optional                 | relative order, core-owned & never surfaced; absent outside the rankable set                      | lifecycle/hold verbs, `reorder`       |
| `external_ref` | scalar           | **task**, optional                 | outward GitHub issue/PR ref                                                                       | `create` / `update`                   |
| `upstream`     | scalar           | **task**, optional                 | `KEY-sN` seed pointer, reference-only ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)) | `create` / `update`                   |
| `completed_at` | timestamp        | **task**, optional                 | stamped only on `done`                                                                            | `done`                                |
| `target`       | string           | **phase**, optional                | the milestone/testable result the phase aims at                                                   | `create` / `update`                   |
| `open_ended`   | bool-as-string   | **container** (non-task), optional | `'true'` \| `'false'`; opts a phase/initiative out of done-rollup ([MMR-204])                     | `create` / `update`                   |

**Body sections** (all seeded at create so Norn's `append_to_section` always has an anchor):

- `## Task Description` — the authoritative home for the node's prose. **`description` is not frontmatter** ([MMR-162]): only the short `summary` lede rides frontmatter; the full prose lives here and is edited via a section replace.
- `## History` — the append-only transition log (see [`## History`](#-history--the-transition-log)).
- `## Annotations` — freeform in-flight notes (see [`## Annotations`](#-annotations)).

**Status is two stored axes, and only on tasks** ([ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md)): `lifecycle` (pure progress) and `hold` (the `none|blocked|parked` overlay). Phases and initiatives store **no** status — their truth is the live distribution over children, derived, never a `status` field. Every surviving task carries a valid `lifecycle` (the validator drops a task missing/foreign on it) and an effective `hold` (absent reconstructs to `none`).

**`rank`** is the relative order ([ADR 0007](decisions/0007-rank-is-primary-order-priority-is-signal.md)), an integer-with-gaps that is **never returned to consumers** — re-spreading preserves order while changing integers. It is present only for a task in the **rankable set** (`lifecycle ∈ {todo, in_progress} ∧ hold = none`); the lifecycle/hold verbs set it on entry (append-to-bottom) and clear it on exit, and `reorder` moves it.

**`priority` / `size` are nullable signals, by design** — absent means _untriaged / unsized_, a real surfaceable state. The core forces no default; a consumer may impose one. Both are coarse: they filter and advise `rank`, never order it.

## Dependencies

A node's prerequisites are the **`depends_on` wikilink list in its own frontmatter** — there is no separate dependency document or table. `node → depends_on[i]` means the node waits on that prereq. `blocked`, `awaiting`, `blocking`, and `ready` are all _derived_ from these edges (design §4), never stored. Tasks are the common case; initiative→initiative prerequisites use the same field. Each add/remove writes a `dependency` record to `## History`.

The validator prunes a dangling or cycle-closing edge on read (the node survives, minus that prereq); the write path **re-merges** a pruned ref when rewriting the field so corruption isn't silently erased — `mimir doctor` keeps surfacing it and repair stays a deliberate `doctor --fix` ([ADR 0017](decisions/0017-runtime-data-tolerance.md)).

## `## History` — the transition log

The append-only history ([ADR 0003](decisions/0003-append-only-transition-log.md)) written **in the same atomic plan** as the state change, by the same verb, so the frontmatter and the log can't drift. Each transition is one H3 record under the `## History` H2 anchor:

```md
### <ISO timestamp> — <kind>

<edge>
<reason?>
```

- **`<kind>`** ∈ `lifecycle` | `hold` | `dependency` | `move` | `archive`. `archive` is **project-keyed** (it appends to the project doc's `## History`, [ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)); the rest are node-keyed.
- **`<edge>`** is the sole change carrier: a two-sided change renders `from → to` (lifecycle/hold/move/archive); a one-sided edge change renders `+to` when an edge was added or `-from` when one was removed (`dependency`); a null-both change renders `—`.
- **`<reason?>`** is everything after the edge line (multi-line, unicode-preserving; heading-shaped lines are backslash-escaped to round-trip). This is the home of transition **reasons** — an abandon/park/block reason rides its History record, beside the state change it explains, not in an annotation.

Derived flip-times (`became_ready_at`, `recently_completed`) are computed from this feed against a caller-supplied cursor, **never stored**.

## `## Annotations`

Freeform in-flight notes on a node — the lightweight middle ground between the frozen `## Task Description` and a heavy session-log artifact. Each is one H3 record under the `## Annotations` H2 anchor, with **no id, no kind, no edge** — only the created-at heading and the note body:

```md
### <ISO timestamp>

<note content>
```

Appended by `annotate`. Nodes only — projects carry no `## Annotations`. Transition reasons do **not** live here (they ride `## History`).

## `artifact` — `KEY/artifacts/KEY-aN.md`

A frozen markdown document — not diffed or edited in place, only ever added to. **Anchored to exactly one project** (required); **linked to 0..N nodes** via `anchor` (optional context) ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)). No `type` classification enum and no `consolidated_at`: `spec`/`plan`/`session_log` and consolidation state are **tags** ([ADR 0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)/0004). Correct a bad artifact by attaching a new one.

| Field     | Type             | Presence | Allowed / default                               | Written by          |
| --------- | ---------------- | -------- | ----------------------------------------------- | ------------------- |
| `type`    | string           | always   | `artifact`                                      | `attach`            |
| `title`   | string           | always   | display title                                   | `attach` / `update` |
| `project` | wikilink         | always   | `[[KEY]]` (the required project home)           | `attach`            |
| `created` | timestamp        | always   | ISO-8601 UTC                                    | `attach`            |
| `anchor`  | list of wikilink | optional | `[[KEY-seq]]` node stems, 0..N (the "link" set) | `attach` (`--link`) |
| `tags`    | list of string   | optional | opaque strings                                  | `tag` / `untag`     |

**Body:** the frozen artifact content (markdown). Artifacts have **no `updated_at`** (append-only) and **reject tag notes** — frontmatter `tags` are plain strings with nowhere faithful to store a per-tag note.

## `seed` — `KEY/seeds/KEY-sN.md`

The grooming-queue record ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)/[0021](decisions/0021-seed-lede-derived-and-capture-grammar.md)): project-anchored, its own `KEY-sN` id, **not** a node. A seed's lifecycle is triage progress, and both `kind` and `lifecycle` are **required closed fields**, not tags (the feature interprets them, so [ADR 0005](decisions/0005-grouping-axis-is-tags.md) does not apply).

| Field        | Type             | Presence | Allowed / default                                                                     | Written by                     |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| `type`       | string           | always   | `seed`                                                                                | `seed` (capture)               |
| `title`      | string           | always   | display title                                                                         | `seed` / `update`              |
| `project`    | wikilink         | always   | `[[KEY]]` (the anchoring project)                                                     | `seed`                         |
| `kind`       | string           | always   | `idea` \| `bug` \| `feature`                                                          | `seed` / `update`              |
| `lifecycle`  | string           | always   | `new` \| `promoted` \| `resolved` \| `rejected`; starts `new`                         | `promote`, `resolve`, `reject` |
| `created`    | timestamp        | always   | ISO-8601 UTC                                                                          | `seed`                         |
| `updated_at` | timestamp        | always   | ISO-8601 UTC                                                                          | every write                    |
| `requester`  | wikilink         | optional | `[[KEY]]` of a requesting project; nulled on read if that project is unknown/archived | `seed`                         |
| `spawned`    | list of wikilink | optional | `[[KEY-seq]]` work nodes germinated from this seed                                    | `promote`                      |

**Body sections** (same full shape as a node): `## Seed Description` (the prose lede — body, never frontmatter, like a task's description), `## History` (lifecycle transitions), `## Annotations` (triage notes).

**Lifecycle machine:** `new → promoted | resolved | rejected` and `promoted → resolved | rejected`. `resolved`/`rejected` are terminal (a terminal seed is frozen — `patch`/`transition` refuse it); the terminal states are set only by explicit triager verbs, never derived from spawned work. `promote`/germinate moves `new → promoted` and appends the spawned node to `spawned` in one atomic plan.

The task-side `upstream` field (see the node table) is the requester-side pointer at a seed — reference-only in v1, resolved by the read seam; the validator surfaces a malformed or dangling `upstream`.

## `tags`

The whole grouping axis and classification layer ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)/[0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)) is a single **`tags` frontmatter list of opaque strings** on any project, node, or artifact — `workspace:*` on projects, `release:*` on tasks, `spec`/`consolidated` classification, all uniform. Seeds do **not** carry tags: their classification (`kind`) and triage state (`lifecycle`) are intrinsic closed fields, not tags. The core does set-membership filtering composed with structural scope (`project = X AND has(tag)`) and **never parses** the string.

The vault stores **only the string**: there is **no per-tag `note` and no per-tag timestamp**. (The old backend's `tag` table carried both; both are gone.) The reader synthesizes a uniform `note = null` and a `created_at` equal to the document's own `created`, so downstream shapes still type-check. `tag --note` is therefore rejected on a vault-backed artifact, and unavailable in general — an opaque note about a tag attachment has nowhere faithful to live. Removing a tag is a plain, unlogged frontmatter delete (`untag`).

---

## Closed vocabularies

Enforced in code by the shared validator ([ADR 0017](decisions/0017-runtime-data-tolerance.md)), single-sourced in `@mimir/contract`. A present, out-of-vocabulary value is either a **node/record drop** (load-bearing) or a **field null** (optional):

| Field                  | Values                                                     | Bad value ⇒                    |
| ---------------------- | ---------------------------------------------------------- | ------------------------------ |
| node `type`            | `initiative`, `phase`, `task`                              | not a work node                |
| task `lifecycle`       | `todo`, `in_progress`, `under_review`, `done`, `abandoned` | drop node (missing or foreign) |
| task `hold`            | `none`, `blocked`, `parked` (absent ⇒ `none`)              | drop node (present & foreign)  |
| task `priority`        | `p0`, `p1`, `p2`, `p3`                                     | null field (node survives)     |
| task `size`            | `small`, `medium`, `large`                                 | null field (node survives)     |
| container `open_ended` | `true`, `false`                                            | null field (node survives)     |
| transition `kind`      | `lifecycle`, `hold`, `dependency`, `move`, `archive`       | record skipped on read         |
| seed `kind`            | `idea`, `bug`, `feature`                                   | drop seed record               |
| seed `lifecycle`       | `new`, `promoted`, `resolved`, `rejected`                  | drop seed record               |
| tag entity             | `project`, `node`, `artifact` (seeds carry no tags)        | —                              |

The **status word** vocabulary (`ready`, `awaiting`, `blocked`, `parked`, `in_progress`, `under_review`, `done`, `abandoned`, and `new` for empty containers — [ADR 0008](decisions/0008-state-word-projection-and-interpret-cascade.md)) is a **derived projection**, not a stored field.

## Derived — never stored

Query-layer outputs, intentionally **absent** from every document ([ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md)/[0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md), design §4–5). Storing any of these reintroduces the sync surface Mimir exists to remove:

- **Predicates:** `ready`, `awaiting`, `blocked`, `blocking`, `stale`, `orphaned`.
- **Rollup:** a non-leaf node's status **distribution** (`{done:3, ready:1}`) and its `interpret()` status word — computed live over direct children, never cached.
- **Transition cursors:** `newly_ready`, `recently_completed` (a caller cursor over `## History`); `unconsolidated` (a tag query).
- **Rendered ids / flip-times:** `KEY-seq`, `became_ready_at`, the seed lede.
- **Allocation counters:** per-project `last_seq` / `last_artifact_seq` — derived as `max(seq)+1` at create time, not persisted.

## Removed vs. the SQLite era

The pre-[MMR-234](decisions/0016-norn-vault-system-of-record.md) DDL modeled the same concepts relationally; the vault re-expresses them. The mapping, for readers coming from the old shape:

| Old (SQLite)                                                   | Now (vault)                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| surrogate `id INTEGER PRIMARY KEY` on every table              | no surrogate id — the file **stem** is the id                                                                 |
| `project.last_seq` / `last_artifact_seq`                       | dropped — seq derived as `max(seq)+1` over the vault                                                          |
| `node.description` column                                      | the `## Task Description` **body section** ([MMR-162])                                                        |
| (none)                                                         | `summary` frontmatter — the short list lede                                                                   |
| (none)                                                         | `open_ended` frontmatter — container done-rollup opt-out ([MMR-204])                                          |
| `dependency` table + reverse index                             | the `depends_on` wikilink list in the node's own frontmatter                                                  |
| `annotation` table                                             | `## Annotations` body records                                                                                 |
| `transition_log` table (node-keyed; kinds l/h/d/move)          | `## History` body records; kinds add `archive`; `archive` is project-keyed                                    |
| `artifact` + `artifact_link` tables                            | one artifact doc with `title` + an `anchor` wikilink list                                                     |
| `tag` table (`entity_type`, `entity_id`, `note`, `created_at`) | a `tags` frontmatter string list; **no note, no per-tag timestamp**                                           |
| `project_id` FK on nodes/artifacts                             | a `project` wikilink (query-scope handle) + the authoritative stem                                            |
| `CHECK` constraints (type integrity, enums)                    | the shared validator ([ADR 0017](decisions/0017-runtime-data-tolerance.md)); type-gating in the writer/reader |

## Status

The frontmatter contract is **settled and maintained**: the value sets, the omit-empty and wikilink conventions, the body-section grammar, and the timestamp format above are the shape Norn's read and write paths are built from and round-trip through. It moves with the model — a schema-affecting change updates this reference in step. The vault's referential and field integrity is owned by the shared validator ([ADR 0017](decisions/0017-runtime-data-tolerance.md)) and surfaced by `mimir doctor`, not by database constraints.
