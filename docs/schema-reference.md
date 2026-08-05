---
title: 'mimir Schema Reference'
status: accepted
date: 2026-07-13
---

# mimir Schema Reference

The concrete shape of the model — realized as the vault's **markdown frontmatter and body sections** — decided across ADRs [0001](decisions/0001-task-status-two-axes-derived-rollup.md)–[0007](decisions/0007-rank-is-primary-order-priority-is-signal.md), extended by seeds ([0020](decisions/0020-seeds-grooming-queue-entity.md)/[0021](decisions/0021-seed-lede-derived-and-capture-grammar.md)), Scratchpads ([0027](decisions/0027-scratchpads-are-temporary-episode-state.md)), and the project archive ([0015](decisions/0015-project-archive-frozen-and-hidden.md)). This is a **maintained reference**, not a frozen artifact: the vault's frontmatter and Norn's handling of it are built from here, and this document is kept honest as the model moves. The ADRs hold the _why_ in full; this note holds the _shape_ plus enough prose to construct valid Norn documents without re-deriving the contract from code.

> **Single source of truth is the vault.** The durable record is the markdown itself — hand-editable, git-backed, inspectable. Norn ([ADR 0016](decisions/0016-norn-vault-system-of-record.md)) owns every read, write, and query and maintains its own SQLite **index**; that index is a cache, never the record. Mimir reduces to business logic and derivation over Norn ([ADR 0018](decisions/0018-vault-access-is-norn-only.md): **all vault access is Norn-only** — Mimir never touches files directly). Where this note and a document disagree, the document wins; where an ADR and either disagree, the ADR wins.

## Vault conventions

These hold for every document; the per-entity sections below don't repeat them.

- **The stem is the id** ([ADR 0006](decisions/0006-human-readable-node-ids.md)). A document's identity is its filename stem, spoken by every surface:

  | Entity                            | Id form   | Canonical creation path   |
  | --------------------------------- | --------- | ------------------------- |
  | project                           | `KEY`     | `KEY/KEY.md`              |
  | work node (initiative/phase/task) | `KEY-seq` | `KEY/KEY-seq.md`          |
  | artifact                          | `KEY-aN`  | `KEY/artifacts/KEY-aN.md` |
  | seed                              | `KEY-sN`  | `KEY/seeds/KEY-sN.md`     |
  | scratchpad                        | UUID v4   | `scratch/<uuid>.md`       |

  `KEY` is `[A-Z]{2,4}`, immutable, consumer-supplied. `seq`/`N` are per-project sequence integers allocated by Norn as `max+1` over the project's existing documents during create (1-based, one sequence each for nodes / artifacts / seeds) — there is **no stored allocation counter** ([ADR 0016](decisions/0016-norn-vault-system-of-record.md)). A sequence component is never reused by a Mimir operation while its document exists. Scratchpads are the deliberate exception to the sequenced durable identity grammar: their temporary identity is a cryptographically generated UUID v4.

- **Abandon, don't `rm`.** To retire a task, use its lifecycle (`mimir abandon`) — the document and its `KEY-seq` stay, so the number is never reused and every `KEY-seq` reference stays stable ([ADR 0006](decisions/0006-human-readable-node-ids.md)). Hand-deleting a document (`rm`) is out of contract: because allocation is `max+1`, the next create re-hands the freed number, silently reusing an id. This is accepted, not prevented (a single-user vault deletion is intentional), but surfaced — an interior sequence gap (a missing number below a project's max) is durable deletion evidence, flagged by `mimir doctor` and recoverable with `git revert` over the vault's snapshot history ([ADR 0017](decisions/0017-runtime-data-tolerance.md)).

- **Path locates; stem identifies.** The table above shows where Mimir asks Norn to create a new document, not a second identity or a required permanent location. The Norn adapter retains the actual `stem → vault-relative path` locator for each surviving document in a transaction snapshot because atomic apply operations are path-addressed. Paths never enter the core model or Store seam, and relocating a document inside the vault does not change its Mimir identity.

- **Duplicate stems are corruption.** If multiple work-state documents have the same canonical stem, the tolerant reader chooses neither: it excludes every colliding document from the valid working set and withholds their locators. `mimir doctor` reports the collision with every path so repair is explicit rather than scan-order-dependent.

- **Relations are Obsidian wikilinks.** `project`, `parent`, `depends_on`, `anchor`, `requester`, and `spawned` are written as `[[STEM]]` (or `[[STEM|alias]]`); Norn collapses the brackets in field matching, so `vault.find --eq project:KEY` resolves them. The reader de-aliases them to the same canonical bare stems carried by the core model and Store seam. `upstream` and `external_ref` are **plain scalars**, not wikilinks.

- **Omit-when-empty.** Only the identity/type/timestamp fields are always present. Every other field is written **only when it has a value**; an absent field means "unset," and the reader supplies the documented default (a task's absent `hold` → `none`). A deliberate neutral value (`hold: none`) is written as absence.

- **Closed vocabularies are validator-enforced, not vault-enforced.** Norn has no enum/boolean field type, so value legality can't be checked at the vault layer ([ADR 0016](decisions/0016-norn-vault-system-of-record.md) sketched write-time value enforcement in Norn; the implementation landed it validator-side per [ADR 0017](decisions/0017-runtime-data-tolerance.md)'s tolerance model). The shared graph validator ([ADR 0017](decisions/0017-runtime-data-tolerance.md), consumed by both the tolerant reader and `mimir doctor`) is the guard: it drops or nulls out-of-vocabulary values (see [Closed vocabularies](#closed-vocabularies)). `open_ended` booleans serialize as the strings `'true'`/`'false'`.

- **Timestamps** are ISO-8601 UTC strings, with millisecond precision and an explicit `Z` — human-readable, and lexically = chronologically sortable. The **creation** timestamp's frontmatter key is `created` (not `created_at`); the mutation/completion/archive stamps keep their `_at` suffix: `updated_at`, `completed_at`, `archived_at`. `created` is set once; `updated_at` is re-stamped by the core on every write. UTC always — local time is a UI-edge rendering, never stored.

  That form is an **invariant of the stored value**, not merely a write convention ([ADR 0029](decisions/0029-caller-zoned-date-semantics.md), MMR-351): the query paths, the annotation sort, and the transition cursor all compare stored stamps as raw strings, and lexical order tracks chronology only while every value shares one width, one precision, and one zone. Norn's `datetime` type is broader — it accepts an offset zone, an absent millisecond, a space separator, even a zone-less value — so the invariant is enforced above it. Vault schema 9 converges an older vault by rewriting every variant that states its instant unambiguously (`2026-08-05T15:00:00+05:30` → `2026-08-05T09:30:00.000Z`), including the space-separated and colon-less-offset forms a stored value may already carry. Note this is deliberately a shade wider than the **query-input** grammar of [ADR 0029](decisions/0029-caller-zoned-date-semantics.md): what a caller may _type_ stays narrow (one spelling per instant), while a value already in a document is judged only on whether its instant is unambiguous. A **zone-less or malformed** stored value states none, so it is never guessed at — it survives the upgrade untouched and `mimir doctor` reports it as corruption requiring an explicit correction (`uninterpretable-timestamp`, skipped by `--fix`). The same two classes apply to the `### <ISO timestamp>` headings of `## History` and `## Annotations` records; `doctor --fix` normalizes the repairable ones in place.

---

## Shape at a glance

- **project** (`KEY/KEY.md`) — the scope root and allocation authority. Carries the immutable `key`. Doesn't complete, isn't ranked, has no parent. Body: `## History`, plus `## Next` while a direction narrative is set.
- **work node** (`KEY/KEY-seq.md`) — the typed adjacency tree (`initiative | phase | task`), one document shape with type-gated fields. Only **tasks** carry status (`lifecycle`/`hold`) and `rank`. Body: `## Task Description`, `## History`, `## Annotations` — plus `## Next` on a **container** (initiative/phase) while a direction narrative is set.
- **dependency** — not its own document: a node's prerequisites are the `depends_on` wikilink list in **its own** frontmatter. `blocked`/`ready`/`blocking` are _derived_ from these, never stored.
- **annotation** — not its own document: freeform in-flight notes are `## Annotations` records in the node's body.
- **transition / history** — not its own document: the append-only log ([ADR 0003](decisions/0003-append-only-transition-log.md)) is `## History` records in the node's (or project's, for `archive`) body.
- **artifact** (`KEY/artifacts/KEY-aN.md`) — frozen markdown blob, anchored to one project, linked to 0..N nodes via the `anchor` field ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)).
- **seed** (`KEY/seeds/KEY-sN.md`) — the grooming-queue record ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)): project-anchored, its own `KEY-sN` id, **not** a node. Body: `## Seed Description`, `## History`, `## Annotations`.
- **scratchpad** (`scratch/<uuid>.md`) — temporary, project-anchored episode state ([ADR 0027](decisions/0027-scratchpads-are-temporary-episode-state.md)), with an append-only numbered Journal and lifecycle-owned numbered Agenda. It freezes into a complete Artifact or is discarded; it is not a node or mutable Artifact.
- **tag** — not its own document: an opaque string in the `tags` frontmatter list on any project/node/artifact ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)); seeds carry no tags. The vault stores **no per-tag note or timestamp**.

---

## `project` — `KEY/KEY.md`

The scope root. Categorically not a node: it doesn't complete (no status), isn't ordered (no rank), has no parent. Workspace grouping is a **tag** (`workspace:*`), not an FK ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)) — there is no `workspace_id`. The core model and Store seam know **no repo checkout or vault document paths** ([ADR 0011](decisions/0011-repo-binding-is-repo-side.md)); the repo→project binding lives repo-side in a checked-in `.mimir.toml`, while the Norn adapter privately retains the current vault locator needed for writes.

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

**Body:** `## History` (projects carry no `## Annotations`). Project-keyed `archive`/`unarchive` transitions ([ADR 0015](decisions/0015-project-archive-frozen-and-hidden.md)) append here. A project also carries the optional `## Next` direction narrative — see [`## Next`](#-next--the-direction-narrative).

There is **no `last_seq` / `last_artifact_seq`** in the vault — these were allocation counters of the retired backend; seq is now derived over the vault ([ADR 0016](decisions/0016-norn-vault-system-of-record.md)).

## `node` — `KEY/KEY-seq.md` (initiative | phase | task)

One document shape absorbs the semi-regular hierarchy (a monorepo sub-project, a phaseless initiative, a spec-less task). Type-specific fields are **type-gated**: the writer emits them only for the owning type, and the reader reads them only for it, so a stray value on the wrong type never projects. The canonical id is the `KEY-seq` stem; `project` and `parent` are wikilinks carrying the project key and parent stem. `parent` **absent** means top-level under the project (a root); it is never a bare project `KEY`.

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
| `host`         | string           | **task**, optional                 | resume handle — the machine the work is happening on                                              | `create` / `start` / `update`         |
| `harness`      | string           | **task**, optional                 | resume handle — the agent harness running it                                                      | `create` / `start` / `update`         |
| `session`      | string           | **task**, optional                 | resume handle — the session id to resume from                                                     | `create` / `start` / `update`         |
| `branch`       | string           | **task**, optional                 | resume handle — the branch the work lives on                                                      | `create` / `start` / `update`         |
| `completed_at` | timestamp        | **task**, optional                 | stamped only on `done`                                                                            | `done`                                |
| `target`       | string           | **phase**, optional                | the milestone/testable result the phase aims at                                                   | `create` / `update`                   |
| `open_ended`   | bool-as-string   | **container** (non-task), optional | `'true'` \| `'false'`; opts a phase/initiative out of done-rollup ([MMR-204])                     | `create` / `update`                   |

**Body sections** (all seeded at create so Norn's `append_to_section` always has an anchor):

- `## Task Description` — the authoritative home for the node's prose. **`description` is not frontmatter** ([MMR-162]): only the short `summary` lede rides frontmatter; the full prose lives here and is edited via a section replace.
- `## History` — the append-only transition log (see [`## History`](#-history--the-transition-log)).
- `## Annotations` — freeform in-flight notes (see [`## Annotations`](#-annotations)).

One further section is **not** seeded at create and appears only while it is set: `## Next`, the container-only direction narrative (see [`## Next`](#-next--the-direction-narrative)).

**Status is two stored axes, and only on tasks** ([ADR 0001](decisions/0001-task-status-two-axes-derived-rollup.md)): `lifecycle` (pure progress) and `hold` (the `none|blocked|parked` overlay). Phases and initiatives store **no** status — their truth is the live distribution over children, derived, never a `status` field. Every surviving task carries a valid `lifecycle` (the validator drops a task missing/foreign on it) and an effective `hold` (absent reconstructs to `none`).

**`rank`** is the relative order ([ADR 0007](decisions/0007-rank-is-primary-order-priority-is-signal.md)), an integer-with-gaps that is **never returned to consumers** — re-spreading preserves order while changing integers. It is present only for a task in the **rankable set** (`lifecycle ∈ {todo, in_progress} ∧ hold = none`); the lifecycle/hold verbs set it on entry (append-to-bottom) and clear it on exit, and `reorder` moves it.

**`priority` / `size` are nullable signals, by design** — absent means _untriaged / unsized_, a real surfaceable state. The core forces no default; a consumer may impose one. Both are coarse: they filter and advise `rank`, never order it.

**`host` / `harness` / `session` / `branch` are resume handles, not telemetry** ([ADR 0026](decisions/0026-work-state-composition.md) Decision 3). They answer three forensic questions — what is happening, what did happen, how do I continue — and nothing else: anything recoverable _from_ the session (model, durations, token counts) stays out, because Mimir stores the keys into richer stores and mining happens there. They are free strings on the update plane, so `start` records them as the claim (CLI `--host/--harness/--session/--branch`, the same args on MCP and HTTP) and a plain `update` overwrites them — **there is no claim verb**: `in_progress` already is the claim, and `start`'s CAS-guarded `todo→in_progress` assert already makes claiming atomic, so resume and takeover are ordinary patches (a blank clears one). The lifecycle verbs clear all four on the terminal transitions (`done`, `abandon`) and on the holds (`park`, `block`) — held or settled work is not in flight, and a stale pointer is worse than an absent one — but **keep** them through `submit`/`under_review` and `return`, where the branch and session are still the live pointers at the human gate. `reopen`/`unpark`/`unblock` restore nothing; a resuming agent re-states them. Absence is always legitimate, so nothing detects, defaults, or repairs a missing handle, and Mimir makes no liveness claim: consumers judge from the handles, with the `stale` predicate as the coarse backstop. PR linkage rides `external_ref`, not these.

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
- **The resume-handle echo** ([ADR 0026](decisions/0026-work-state-composition.md) Decision 3): a transition that _moves_ the handles appends them to its edge line as ` · key=value` pairs in canonical key order — `todo → in_progress · branch=feat/x · host=box`. `start` echoes **the claim state at the transition** (what the task carries once claimed — including a handle pre-seeded at `create`, not only what its own flags stamped); the clearing transitions (`done`/`abandon`, `park`/`block`) echo what they cleared. Claim succession therefore survives in the append-only log. It rides the **edge** line, not a line of its own, because that line is machine-written on both sides and can never be confused with a hand-authored reason; it is omitted entirely when no handle moved, so every other row is byte-identical to a pre-handle one. A handle value can carry neither a line break nor the pair separator — a `·` **surrounded by spaces**, the one sequence that would read back as a handle nobody set. That is the whole rule and it is narrow: a bare `a·b` is legal, and so is a trailing or leading `·`. The write verbs **reject** a value that breaks it (after whitespace collapses, so `a\n·\nb` is caught too), and the echo flattens whatever a hand edit has already put in the vault — so a hand-edited document can neither forge a row nor block a verb.

Derived flip-times (`became_ready_at`, `recently_completed`) are computed from this feed against a caller-supplied cursor, **never stored**.

## `## Annotations`

Freeform in-flight notes on a node — the lightweight middle ground between the frozen `## Task Description` and a heavy session-log artifact. Each is one H3 record under the `## Annotations` H2 anchor, with **no id, no kind, no edge** — only the created-at heading and the note body:

```md
### <ISO timestamp>

<note content>
```

Appended by `annotate`. Nodes only — projects carry no `## Annotations`. Transition reasons do **not** live here (they ride `## History`).

## `## Next` — the direction narrative

The one **owned prose surface above task granularity** ([ADR 0026](decisions/0026-work-state-composition.md) Decision 2). What to work on next is derived (ready ∩ rank) and is never stored; the non-derivable residue — the editorial statement of where a project or container is headed — lives here, as free markdown under a `## Next` H2 on a **project**, **initiative**, or **phase** document. Tasks carry none: a task's prose homes are `## Task Description` and `## Annotations`.

Unlike the other body sections it is **not seeded at create**. The heading exists only while the narrative is set, so an absent section and an empty one are the same state, and every projection omits the field entirely when it is unset.

**Replace-not-append.** `update <id> --direction "<text>"` (CLI; `next` on MCP and HTTP) re-authors the **whole** section — there is no append grain, which is precisely what kept hand-maintained work-state sections growing monotonically. A blank value **clears** it, removing the heading with the prose. The write rides the ordinary CAS-guarded plan and co-stamps `updated_at`; re-authoring the identical text writes nothing at all, so the stale clock doesn't move on a no-op. A concurrent write that drifts the document refuses on that CAS — the writer re-reads and re-authors against the current board rather than replaying a stale draft.

The prose is **uncapped**, like `## Task Description` — only the short `summary` lede carries a length limit. Heading-shaped lines are backslash-escaped exactly as in the other sections, so an arbitrary markdown body round-trips.

**A duplicated `## Next` refuses the write.** norn warn-omits an _ambiguous_ heading from a section read exactly as it omits a _missing_ one, and its structured `section_failures` channel does not distinguish the two — so "the section didn't resolve" cannot be read as "there is no section". The write path counts semantic headings in the body (heading-shaped text inside fenced or indented code is literal code): two or more, and the write refuses and points at `mimir doctor` rather than splicing in yet another copy (or reporting a clear that removed nothing). Reads degrade to empty, like every other ambiguous section ([ADR 0017](decisions/0017-runtime-data-tolerance.md)), and `mimir doctor` reports `duplicate-next-section` naming each extra heading's line. A first write also needs exactly one `## History` anchor to splice in above; a document with none, or with several, refuses by name instead of as an opaque apply failure — and the two are told apart, since adding the heading and deleting the duplicate are opposite repairs. The narrative is set only through `update`: `create` refuses `--direction` (and the HTTP create body rejects a stray `next`) rather than accepting prose it would discard.

Reads: `get KEY` / `get KEY-seq` carry it by default, and `--col next` names it explicitly. On a **container** it is free — it rides the one batched section read `## Task Description` already pays for. On a **project** it costs one extra document read, since a project's `description` is frontmatter and its detail read otherwise touches no body. Bulk paths (`list`, `next`, `tree`) pass their own facet lists and exclude it.

## `artifact` — `KEY/artifacts/KEY-aN.md`

A frozen markdown document — not diffed or edited in place, only ever added to. **Anchored to exactly one project** (required); **linked to 0..N nodes** via `anchor` (optional context) ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)). No `type` classification enum and no `consolidated_at`: `spec`/`plan`/`session_log` and consolidation state are **tags** ([ADR 0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)/0004). Correct a bad artifact by attaching a new one.

| Field            | Type             | Presence                                               | Allowed / default                               | Written by                    |
| ---------------- | ---------------- | ------------------------------------------------------ | ----------------------------------------------- | ----------------------------- |
| `type`           | string           | always                                                 | `artifact`                                      | `attach`                      |
| `title`          | string           | always                                                 | display title                                   | `attach` / `update`           |
| `summary`        | string           | optional                                               | ≤256-char lede, newlines collapsed              | `attach` / `update`           |
| `project`        | wikilink         | always                                                 | `[[KEY]]` (the required project home)           | `attach`                      |
| `created`        | timestamp        | always                                                 | ISO-8601 UTC                                    | `attach`                      |
| `updated_at`     | timestamp        | always on new docs; legacy absent until `doctor --fix` | ISO-8601 UTC                                    | `attach` + metadata mutations |
| `anchor`         | list of wikilink | optional                                               | `[[KEY-seq]]` node stems, 0..N (the "link" set) | `attach` (`--link`)           |
| `tags`           | list of string   | optional                                               | opaque strings                                  | `tag` / `untag`               |
| `source_scratch` | string           | optional                                               | canonical Scratchpad UUID; freeze provenance    | Scratchpad freeze             |

`summary` is the artifact's optional lede — the same field a node carries, with the same 256-character cap and the same core normalization (newlines collapse to spaces, blank stores as absent). Absence is a legitimate state, so it is neither required nor repaired: nothing detects or stamps a missing one. With `title` it makes the artifact's two mutable fields; the body stays frozen.

**Body:** the frozen artifact content (markdown) — never re-stamped, since the body is append-only, not edited. `updated_at` tracks **metadata** mutations only (retitle, re-lede, tag/untag): it is the CAS drift guard those writes co-stamp, exactly like the node/project/seed write paths (MMR-303/313/317). A metadata mutation that would write against an artifact whose `updated_at` is missing or null refuses as degraded vault state until `mimir doctor --fix` stamps it (a no-op — e.g. clearing an already-absent summary — writes nothing and passes); legacy artifacts predating the field are repaired that way (the field is **not** `required_frontmatter`, deliberately, so the missing-field flow routes through the supported `missing-updated-at` → `stamp-updated-at` repair). Like every entity, artifacts **carry no tag notes** — the tag surface has no note parameter at all (ADR 0005 Refinement, MMR-270).

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

## `scratchpad` — `scratch/<uuid>.md`

A Scratchpad is temporary, project-anchored state for one unsettled work episode ([ADR 0027](decisions/0027-scratchpads-are-temporary-episode-state.md)). Its filename stem is a canonical lowercase UUID v4 generated by the runtime. The storage seam accepts exact UUIDs only; any human-facing prefix convenience belongs above it.

| Field         | Type             | Presence | Allowed / default                                 | Written by               |
| ------------- | ---------------- | -------- | ------------------------------------------------- | ------------------------ |
| `type`        | string           | always   | `scratch`                                         | Scratchpad create        |
| `project`     | wikilink         | always   | `[[KEY]]`, the one required project home          | create                   |
| `title`       | string           | always   | display title                                     | create / metadata update |
| `created`     | timestamp        | always   | canonical ISO-8601 UTC milliseconds               | create                   |
| `updated_at`  | timestamp        | always   | canonical ISO-8601 UTC milliseconds               | every working mutation   |
| `anchor`      | list of wikilink | optional | same-project linked-work stems                    | create / metadata update |
| `freezing_at` | timestamp        | optional | present while the idempotent freeze protocol runs | freeze lifecycle         |

`created <= updated_at` is the only relational timestamp invariant. Journal timestamps use the same canonical representation, but their numbering—not wall-clock order—is authoritative; they need not be monotonic or equal `updated_at`. A valid `freezing_at` document remains readable so the service can recover an interrupted freeze.

The body contains exactly one `## Journal` and one `## Agenda`. Their local number spaces are independent, start at 1, and remain contiguous and monotonic:

```md
## Journal

### 1 — 2026-08-01T20:44:00.000Z

Freeform checkpoint prose.

## Agenda

1. [ ] Open question
2. [x] Settled question
3. [-] Superseded question — reason: replaced by agenda 7
```

Journal records are append-only free Markdown. Agenda supports only add (`[ ]`), complete (`[x]`), and supersede with a required reason (`[-] ... — reason: ...`). Reopening or deleting an item is not a transition; a revived concern gets a new number referencing the old item.

Owned-section corruption—missing or duplicate headings, malformed owned records, or duplicate/missing/out-of-order sequence numbers—quarantines the entire Scratchpad from normal reads. The raw document remains untouched and `mimir doctor` reports the same codec findings; `doctor --fix` never repairs Scratchpad body semantics. A missing or invalid owning project also quarantines the record. An invalid, dangling, or cross-project optional `anchor` is instead pruned individually and diagnosed, matching the non-load-bearing edge-tolerance posture.

## `tags`

The whole grouping axis and classification layer ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)/[0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)) is a single **`tags` frontmatter list of opaque strings** on any project, node, or artifact — `workspace:*` on projects, `release:*` on tasks, `spec`/`consolidated` classification, all uniform. Seeds do **not** carry tags: their classification (`kind`) and triage state (`lifecycle`) are intrinsic closed fields, not tags. The core does set-membership filtering composed with structural scope (`project = X AND has(tag)`) and **never parses** the string.

The vault stores **only the string**: there is **no per-tag `note` and no per-tag timestamp**. (The old backend's `tag` table carried both; both are gone.) **A tag application carries no note on any entity** ([ADR 0005](decisions/0005-grouping-axis-is-tags.md) Refinement, MMR-270): membership is the whole signal, and the note parameter is retired from the entire surface — note-intent routes to `## Annotations` (one-off rationale) or a tagged artifact (shared grouping metadata, ADR 0005's own pattern). The reader synthesizes a `created_at` equal to the document's own `created`. Removing a tag is a plain, unlogged frontmatter delete (`untag`).

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
- **Flip-times / presentation:** `became_ready_at`, the seed lede.

## Status

The frontmatter contract is **settled and maintained**: the value sets, the omit-empty and wikilink conventions, the body-section grammar, and the timestamp format above are the shape Norn's read and write paths are built from and round-trip through. It moves with the model — a schema-affecting change updates this reference in step. The vault's referential, identity, and field integrity is owned by the shared validator ([ADR 0017](decisions/0017-runtime-data-tolerance.md)) and surfaced by `mimir doctor`, not by database constraints; duplicate canonical stems fail closed and remain diagnosable by every colliding path.
