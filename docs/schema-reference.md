---
title: 'mimir Schema Reference'
status: accepted
date: 2026-06-04
---

# mimir Schema Reference

The concrete shape of the model — realized as the vault's markdown frontmatter — decided across ADRs [0001](decisions/0001-task-status-two-axes-derived-rollup.md)–[0007](decisions/0007-rank-is-primary-order-priority-is-signal.md). This is a **maintained reference**, not a frozen artifact: the vault's frontmatter and Norn's handling of it are built from here, and this document is kept honest as the model moves. The ADRs hold the _why_ in full; this note holds the _shape_ plus enough prose to build without re-deriving.

> **Single source of truth is the vault.** Once an entity's frontmatter exists in the vault, it is authoritative and this note is a design projection — keep them in step, and prefer the ADRs over either when they disagree. Norn owns storage and keeps its own internal index; that index is a cache, never the record.

## Shape at a glance

- **`project`** — the scope root and allocation authority. Carries the immutable **key** and the per-project `last_seq` counter. Does _not_ complete, isn't ranked, has no parent.
- **`node`** — the typed adjacency tree (`initiative | phase | task`) in one table ([ADR 0006](decisions/0006-human-readable-node-ids.md) spine). Type-specific fields are nullable columns; only **tasks** store status and rank.
- **`dependency`** — node→node edges; `blocked`/`ready`/`blocking` are _derived_ from these, never stored.
- **`annotation`** — freeform in-flight notes on a task.
- **`artifact`** + **`artifact_link`** — frozen blobs, anchored to one project, linked to 0..N nodes ([ADR 0004](decisions/0004-artifact-model-project-anchored-flexibly-linked.md)).
- **`seed`** — the grooming-queue entity ([ADR 0020](decisions/0020-seeds-grooming-queue-entity.md)): project-anchored, its own `KEY-sN` id, **not** a node. Lives in the vault the same way every entity does — a markdown doc at `KEY/seeds/KEY-sN.md` — no special-casing. See the ADR for its frontmatter/lifecycle shape.
- **`tag`** — opaque strings on any project/node/artifact; the whole grouping axis ([ADR 0005](decisions/0005-grouping-axis-is-tags.md)) and classification layer ([ADR 0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)).
- **`transition_log`** — append-only history written beside every status-bearing change ([ADR 0003](decisions/0003-append-only-transition-log.md)).

---

## `project`

```sql
CREATE TABLE project (
  id         INTEGER PRIMARY KEY,        -- surrogate identity; every FK/link uses this
  key        TEXT NOT NULL UNIQUE,       -- [A-Z]{2,4}, immutable, consumer-supplied (ADR 0006)
  name       TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0, -- per-project allocation counter; ++ on create, never reused/decremented
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(key) BETWEEN 2 AND 4 AND key GLOB '[A-Z]*')
);
```

A project is **its own table, not a node**, because it is categorically different: it doesn't complete (no status — glossary), it isn't ordered (no rank), it has no parent, and it owns the `key` + `last_seq` allocation machinery (ADR 0006). Folding it into `node` would pollute the tree with project-only columns and a meaningless `seq`. Workspace grouping is a **tag** (`workspace:*`), not an FK (ADR 0005) — so there is no `workspace_id` here. **The store knows no filesystem paths** — the original `repo`/`path` columns were dropped (migration `0004`, ADR 0011); the repo→project binding lives repo-side in a checked-in `.mimir.toml`. (`last_artifact_seq` joined via migration `0002`; this DDL shows the original `0001` shape otherwise.)

## `node` — the typed adjacency tree

```sql
CREATE TABLE node (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES project(id),   -- denormalized onto every node (see note)
  type         TEXT NOT NULL CHECK (type IN ('initiative','phase','task')),
  parent_id    INTEGER REFERENCES node(id),               -- NULL = top-level under the project
  seq          INTEGER NOT NULL,                          -- per-project, immutable, never reused (ADR 0006)
  title        TEXT NOT NULL,
  description  TEXT,

  -- task-only (NULL for initiative/phase) ------------------------------------
  lifecycle    TEXT CHECK (lifecycle IN ('todo','in_progress','under_review','done','abandoned')),
  hold         TEXT CHECK (hold IN ('none','blocked','parked')),
  hold_reason  TEXT,            -- optional context for the current hold (park/block reason is optional, not enforced)
  priority     TEXT CHECK (priority IN ('p0','p1','p2','p3')),  -- SIGNAL, not sort (ADR 0007); NULL = untriaged
  size         TEXT CHECK (size IN ('small','medium','large')), -- medium ~ one session; NULL = unsized; feeds stale policy
  rank         INTEGER,         -- relative order, core-owned, nullable; integer-with-gaps (see note); rankable set only (ADR 0007)
  external_ref TEXT,            -- outward GitHub issue/PR linkage (future-proofing)
  upstream     TEXT,            -- requester-side pointer at a seed (KEY-sN), reference-only (ADR 0020); added via migration 0010, unconstrained by CHECK
  completed_at TEXT,            -- stamped only by complete_task

  -- phase-only ---------------------------------------------------------------
  target       TEXT,            -- the milestone/testable result the phase aims at

  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- type-integrity: structurally-illegal rows are unrepresentable -------------
  CHECK (type = 'task'  OR (lifecycle IS NULL AND hold IS NULL AND hold_reason IS NULL
                            AND priority IS NULL AND size IS NULL AND rank IS NULL
                            AND completed_at IS NULL AND external_ref IS NULL)),  -- only tasks store status/signals/rank
  CHECK (type = 'phase' OR target IS NULL),                                       -- only phases aim at a target
  CHECK (type != 'task' OR (lifecycle IS NOT NULL AND hold IS NOT NULL)),         -- every task has both status axes

  UNIQUE (project_id, seq)
);

CREATE INDEX idx_node_tree       ON node(project_id, parent_id);          -- tree walks
CREATE INDEX idx_node_type       ON node(project_id, type);
CREATE INDEX idx_node_rank       ON node(project_id, rank);               -- next_tasks ordering
CREATE INDEX idx_node_actionable ON node(project_id, lifecycle, hold);    -- ready / rankable filter
```

**One typed table** absorbs the semi-regular hierarchy (a monorepo sub-project, a phaseless initiative, a spec-less task) where five rigid tables would fight it (ADR 0006 spine / design-spec §3.3). Type-specific fields live as **nullable columns**, and the table-level `CHECK`s make the structurally-illegal rows **unrepresentable**: non-task rows carry no status/signal/rank, non-phase rows carry no `target`, and every task has both status axes. The line is clean — **the model forbids structurally-illegal records** (structural, cheap, stable), while **the core owns the behavioral invariants it can't express structurally**: parent type-correctness, cycle-freedom (`move_node`), dependency completeness behind `ready`, the rank reindex.

**`project_id` is denormalized onto every node** (not just derivable by walking `parent_id` to the root) because the three hottest operations are all project-scoped: `seq` allocation (ADR 0006), `rank` ordering/reindex (ADR 0007), and ID rendering (`KEY-seq`). Paying one cheap redundant column beats a recursive CTE on every one of those. The rendered human ID `KEY-seq` is **derived** (`project.key || '-' || seq`), never stored.

**Status is two stored axes, and only on tasks** (ADR 0001): `lifecycle` (pure progress) and `hold` (the `none|blocked|parked` overlay). Phases and initiatives store **no** status — their truth is the live **distribution** over children, so there is deliberately no `status` column on them and no `status_override` anywhere (removed, ADR 0001).

**`rank` is the relative order, encoded as `INTEGER`-with-gaps** (ADR 0007). Inserting "x before y" picks an integer **midpoint** between its neighbours; append-to-bottom is `MAX(rank) + step` (a generous `step`, e.g. 65536, so a fresh column rarely runs short of room). When a midpoint has no integer left (neighbours adjacent), a **reindex** re-spreads the project's rankable set back to clean multiples — run as an **idempotent, stateless nightly background job**: a consumer schedules it, Mimir just exposes `reindex_ranks(project)` and holds **no routine watermark** (consistent with [ADR 0002](decisions/0002-general-purpose-primitives-not-baked-in-semantics.md)), with an **on-the-spot reindex as the rare safety valve** so correctness never waits for night. The hot path stays O(1); the O(n) re-spread is amortized off it and degrades gracefully if scale grows. The whole scheme is **invisible to consumers** — the numbers are core-owned and never returned (ADR 0007), so re-spreading changes integers while preserving order, which is also why the encoding stays a **reversible** choice (swap to lexorank `TEXT` only if scale ever demands). `rank` is `NULL` for any task outside the **rankable set** (`lifecycle ∈ {todo,in_progress} ∧ hold='none'`); the lifecycle/hold verbs set it on entry (append-to-bottom) and clear it on exit.

**`priority` and `size` are nullable signals, by design** — `NULL` means _untriaged / unsized_, a real surfaceable state, not a gap to fill. The core does **not** force a default: defaulting would fabricate a triage decision nobody made and bake a grooming convention into the substrate (ADR 0002). A _consumer_ (e.g. a grooming skill) can impose "everything gets a priority" on top; Mimir keeps the field honest. Both are deliberately **coarse** — they filter and advise `rank`, never order, so more levels would be false precision.

## `dependency` — node→node edges

```sql
CREATE TABLE dependency (
  node_id            INTEGER NOT NULL REFERENCES node(id),
  depends_on_node_id INTEGER NOT NULL REFERENCES node(id),
  PRIMARY KEY (node_id, depends_on_node_id),
  CHECK (node_id != depends_on_node_id)
);
CREATE INDEX idx_dependency_reverse ON dependency(depends_on_node_id);  -- 'blocking' direction
```

Dependencies are **edges, not a field**. `blocked`, `awaiting`, `blocking`, and `ready` are all _derived_ from this table (design-spec §4), never stored — stored derived state is the failure mode Mimir exists to remove. Tasks are the common case; initiative→initiative prerequisites use the same table.

## `annotation` — freeform in-flight notes

```sql
CREATE TABLE annotation (
  id         INTEGER PRIMARY KEY,
  node_id    INTEGER NOT NULL REFERENCES node(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_annotation_node ON annotation(node_id);
```

The lightweight middle ground between a frozen `description` and a heavy session log. **Transition reasons do not live here** (glossary / ADR 0003) — an abandon/park/block reason rides its `transition_log` row, beside the state change it explains.

## `artifact` + `artifact_link` — frozen records

```sql
CREATE TABLE artifact (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),  -- required home: even a zero-task log is findable (ADR 0004)
  content    TEXT NOT NULL,                            -- markdown blob; frozen, append-only
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE artifact_link (
  artifact_id INTEGER NOT NULL REFERENCES artifact(id),
  node_id     INTEGER NOT NULL REFERENCES node(id),
  PRIMARY KEY (artifact_id, node_id)                   -- 0..N work nodes the artifact touched
);
CREATE INDEX idx_artifact_link_node ON artifact_link(node_id);
```

Frozen markdown docs in the vault, one per artifact at `KEY/artifacts/KEY-aN.md` — not diffed/edited in place, only ever added to. **Anchored to exactly one project** (required), **linked to 0..N nodes** (optional context) — ADR 0004. Deliberately **no `type` enum and no `consolidated_at` field** (both removed, ADR 0002/0004): `spec`/`plan`/`session_log` classification and consolidation state are **tags**. Append-only — correct a bad artifact by attaching a new one.

## `tag` — opaque strings, the grouping + classification axis

```sql
CREATE TABLE tag (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project','node','artifact')),
  entity_id   INTEGER NOT NULL,
  tag         TEXT NOT NULL,
  note        TEXT,                                    -- optional, opaque: why THIS attachment; dies with it
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- when applied; see cursor note below
  PRIMARY KEY (entity_type, entity_id, tag)
);
CREATE INDEX idx_tag_lookup ON tag(tag, created_at);  -- has/lacks set-membership + "tagged since X"
```

One polymorphic table because a tag attaches to **anything** (ADR 0002) and carries the _entire_ grouping axis — `workspace:*` on projects, `release:*` on tasks (ADR 0005) — plus the classification layer (`spec`, `consolidated`, …). The core does **set-membership filtering composed with structural scope** (`project = X AND has(tag)`) and **never parses** the string. **Polymorphic is the decided shape** (over three FK-clean join tables `project_tag`/`node_tag`/`artifact_tag`). FK integrity here would only buy cascade-cleanup on a _rare_ delete, and orphan tags are **harmless to correctness** — every tag query joins `tag` to its entity table, so a row pointing at a deleted entity simply doesn't join. Clearing orphans is periodic core **housekeeping**, not an integrity hole. Splitting into three tables would instead fragment a primitive ADR 0002 defines as uniform, triplicate the core's `has`/`lacks` logic, and duplicate the `note`/`created_at` shape — cost without matching benefit. (Contrast the type-integrity `CHECK`s, which are kept _because_ they're free and buy correctness; here DB-enforced integrity is neither.)

**`created_at` recovers the timestamp tag-ification dropped.** When consolidation (and release membership) became tags, the old `consolidated_at` column went away — `created_at` puts the time back: the `consolidated` tag's `created_at` _is_ the consolidation time. It also unlocks the same **caller-cursor** pattern as `transition_log` — "consolidated / tagged `release:v0.37` **since X**" is `tag = ? AND created_at > cursor`, no watermark stored (ADR 0002/0003).

**`note` is opaque context about the _attachment itself_**, not the task — it explains _why this tag is here_ and is meant to vanish if the tag is removed. That's the line against `annotation`: an annotation is about the task's work and outlives any one tag; a tag `note` is cohesive with its attachment. The core never parses it, exactly like the tag string (ADR 0002).

## `transition_log` — append-only history

```sql
CREATE TABLE transition_log (
  id         INTEGER PRIMARY KEY,
  node_id    INTEGER NOT NULL REFERENCES node(id),
  kind       TEXT NOT NULL CHECK (kind IN ('lifecycle','hold','dependency','move')),
  from_value TEXT,
  to_value   TEXT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason     TEXT
);
CREATE INDEX idx_transition_node ON transition_log(node_id, at);
```

Written **in the same transaction** as the state change, by the same lifecycle/hold/dependency/`move` verb, so columns and log can't drift (ADR 0003). Columns stay authoritative ("what now"); the log is "when/how it changed" and the home of transition **reasons**. Derived flip-times — e.g. `became_ready_at = MAX(last readiness-relevant transition, latest dep's completed_at)` — are computed from this, **never stored**, which is what lets `newly_ready since X` work off a caller cursor with no watermark in Mimir.

## Timestamps — one canonical format

Every timestamp field (`created_at`, `updated_at`, `completed_at`, `transition_log.at`, `tag.created_at`) is **`TEXT`, ISO-8601, UTC, millisecond precision with an explicit `Z`**. Chosen over epoch integers because this is vault frontmatter you'll inspect by hand: ISO text is human-readable and sorts lexically = chronologically. Millisecond precision keeps the **caller-cursor** "since X" queries on `transition_log.at` / `tag.created_at` from tying; the transition log is an `at`-ordered best-effort feed with a stable secondary tiebreak, so a cursor is `(at, id) > (X, lastId)`. **UTC always** — local time is rendered only at the UI edge, never stored. `created_at` is set once, at creation; **`updated_at` is stamped by the core on every write** (time-maintenance stays in the sole writer, like the behavioral invariants).

---

## Derived — never columns

These are query-layer outputs, intentionally **absent** from the schema (ADR 0001/0002, design-spec §4–5). Adding any as a stored column reintroduces the sync surface Mimir exists to remove:

- **Predicates:** `ready`, `awaiting`, `blocked`, `blocking`, `stale`, `orphaned`.
- **Rollup:** a non-leaf node's status **distribution** (`{done:3, ready:1}`) and its `interpret()` label — computed live over direct children, never cached.
- **Transition cursors:** `newly_ready`, `recently_completed` (caller-supplied cursor over `transition_log`); `unconsolidated` (a tag query).
- **Rendered IDs / flip-times:** `KEY-seq`, `became_ready_at`.

## Removed vs. the original design spec

Reflecting the ADRs over `mimir-design-spec.md` where they conflict: **gone** are `workspace_id` / `release_id` FKs (→ tags, 0005), `status_override` (0001), the artifact `type` enum and `consolidated_at` (→ tags, 0002/0004), and the single flat `status` enum (→ two axes, 0001). **Added:** `project.key`/`last_seq` + `node.seq` (0006), the `hold` overlay (0001), `transition_log` (0003), `artifact_link` (0004).

## Status

Schema-level design is **settled** as of 2026-06-04 — the five build TBDs are resolved inline above: `priority`/`size` value sets (nullable signals), `rank` encoding (`INTEGER`-with-gaps + nightly reindex), type-integrity `CHECK`s (DB-enforced, row-local), `tag` shape (polymorphic), and timestamps (ISO-ms-`Z` UTC). The next step is the **first migration** in the repo, constructed from this reference. Remaining open items are _not_ schema-blocking and are tracked in the project backlog: the `stale` threshold policy, the `buried`/archaeology predicate family, and the consolidation routine contract.
