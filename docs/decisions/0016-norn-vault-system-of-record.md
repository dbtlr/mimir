---
title: 'ADR 0016: A Norn-managed markdown vault is the system of record'
status: accepted
date: 2026-07-01
---

# ADR 0016: A Norn-managed markdown vault is the system of record

> **Status update (2026-07-12, MMR-234): implemented.** The incremental cutover is
> complete. The SQLite store — implementation, schema/migrations, the `[store]`
> backend fence, and the one-time migration tooling — has been removed; the
> Norn-managed vault is the sole backend. The narrative below is the original
> decision record and describes the now-retired transitional two-backend seam.

Mimir's system of record moves from its own SQLite store to a **Norn-managed
markdown vault**: markdown files are the durable, git-backed, inspectable
truth; Norn owns all reads, writes, queries, and integrity (maintaining its
own SQLite cache as an index); Mimir reduces to a business-logic and
derivation layer that talks to Norn and never touches files directly. The
cutover is incremental, behind a coarse `Store` seam, with SQLite remaining
the default backend until the final phase.

- **One coarse seam, two backends.** All core persistence routes through a
  `Store` interface (bulk working-set projections + write ops) over a
  backend-neutral node/edge/artifact model. SQLite is the first
  implementation; Norn the second. The existing conformance suite is the
  behavior-preservation oracle, run A/B across backends over the live store.
- **O(views) queries, never O(nodes).** Mimir issues one bulk projection per
  view and derives everything else — status words, rollups, predicates,
  lineage — as pure functions in memory. Derivation never fires per-node
  follow-up queries.
- **The stored/derived boundary is unchanged.** `lifecycle` (and the other
  operator-set facts) are stored in frontmatter; derived status is computed
  just-in-time and never persisted (ADR 0001/0008). Selection and stored-field
  aggregation push down into Norn; graph-derived predicates stay in Mimir.
- **Frontmatter is the typed, queryable record; the body is prose plus
  append-records.** Anything a query filters or aggregates on lives in
  frontmatter (`type`, `lifecycle`, `hold`, `project`, `parent`, `depends_on`,
  `anchor`, `tags`, `rank`, `created`, `lastActivity`). The transition log becomes a
  `## History` section appended per verb (ADR 0003's append-only record, now
  human-readable in place); annotations become `## Annotations` records.
- **Relations denormalize onto the node.** A dependency is a `depends_on`
  wikilink array, not a join row; the inverse ("who depends on this") is a
  field-scoped backlink query. Every verb's write reduces to one document —
  except rank reindex, the one genuine multi-document operation. The plan
  surface applies it with **per-document** atomicity, not across documents: a
  rejected content batch leaves the vault byte-identical (NRN-139's
  content-validation phase) and each document's write is crash-atomic, but a
  crash mid-apply _across_ documents can still leave the set partially
  respread — a rank-order inversion, not merely non-clean multiples. That
  residual cross-document rollback gap is tracked as NRN-107.
- **Write path: plan-CAS as the north star.** Norn's plan/apply surface is
  compare-and-swap over documents — build a plan against the state read,
  apply atomically, retry on drift. Until the plan surface covers section
  edits and creates, ordered fallbacks apply (set→edit; create-exclusive
  retry over derived `max(seq)+1` id allocation). The set→edit fallback
  temporarily relaxes ADR 0003's same-transaction pairing of state and log:
  a partial failure leaves correct state with a missing log line — benign
  and reconcilable, retired when the plan surface lands.
- **Integrity splits along prevent/detect.** Mimir enforces what requires
  graph or transition knowledge at its write path (transition legality, the
  no-dependency-parallel-to-lineage rule, same-lineage move guards). Norn
  enforces row-local value legality at write (required fields, allowed
  values) and detects structural drift — schema findings, broken
  references — via its `validate`/`repair` pass, the backstop for writes
  that bypass Mimir entirely (hand edits, git merges, other agents).
  Typed-reference and relational-drift checks are planned additions to that
  validate pass; write-time graph enforcement stays in Mimir regardless.
- **Transport: one persistent stdio MCP client per vault.** Mimir holds a
  single `norn mcp` subprocess and speaks MCP over stdio — warm cache, no
  per-call spawn. Mimir stays an MCP server to agents while becoming an MCP
  client to Norn.

## Why

- **It kills the projection problem instead of managing it.** The founding
  substrate split (work state in SQLite, markdown as projection) made every
  markdown surface a sync liability. With a Norn-managed vault, markdown _is_
  the store — inspectable, greppable, diffable, git-historied — and there is
  nothing to keep in sync.
- **One query engine.** Norn's north star is a query engine for files; Mimir
  becomes its first serious API-only consumer. That consolidates two SQLite
  schemas, two query grammars, and two integrity systems into one engine
  both tools already share conventions with (ADR 0009 adopted Norn's output
  and selection contract).
- **The derivation layer needed the rewrite anyway.** Current derivation is
  async, DB-coupled, and recursively chatty (O(N×depth) queries per rollup).
  Bulk-load + pure in-memory derivation is faster on SQLite too, and makes
  the core trivially testable — the seam phase is independently justified.
- **Risk is contained by construction.** Incremental phases behind the seam,
  every step merged behind the unselected backend, a conformance oracle, and
  a reversible cutover — the irreducibly speculative work is only the
  Norn-backed `Store` implementation and the one-time migration.

## Considered and rejected

- **Keep SQLite and add a write-through markdown projection** — reintroduces
  the status-sync surface this decision exists to kill; every projection is
  a drift liability.
- **Mimir reads/writes the vault directly** (its own markdown engine) —
  duplicates Norn's cache, query, integrity, and locking work, and forfeits
  the one-engine consolidation; the API-only seam is the point.
- **Store derived status in frontmatter** so aggregation can push down —
  caching derived state is the decay the architecture forbids (ADR
  0001/0008); the stored-field fast path plus in-memory overlay covers it.
- **A parallel rewrite branch** — loses the conformance oracle, the A/B
  harness, and mergeability; the seam keeps the tool working throughout.
- **Wait for a Norn network API** — the stdio MCP server is sufficient and
  local-first; a network surface is Norn's own roadmap and orthogonal here.

## Consequences

- **Phasing:** storage seam (pure core, behavior-preserving) → Norn client
  with artifacts first → node reads → node writes + one-time migration →
  cutover and SQLite retirement. Tracked as initiative MMR-126; the
  Norn-side capability work is tracked in the Norn project (NRN-61).
- **Norn's contract becomes load-bearing.** The `find`/`count` filter
  grammar, `--col` projection, rules schema, plan/apply semantics, and MCP
  tool catalog are now an external dependency contract; breaking changes
  there break Mimir.
- **Mimir's vault is its own git repository**, separate from any knowledge
  vault — work state remains out of the knowledge domain.
- **Revises [ADR 0014](0014-work-artifacts-authored-into-mimir.md)'s
  mechanics, preserves its boundary.** Artifacts return to plain files —
  specs, plans, and session logs regain git history and direct readability
  without a CLI door, the portability 0014 consciously traded away — but in
  Mimir's own vault, never a knowledge vault. 0014's decision (work
  artifacts are authored into Mimir, not the knowledge vault) is unchanged;
  its "no file is written" mechanics are superseded.
- **Open items deferred to the phase gates:** how a repo binding names the
  vault — a checked-in vault path sits in tension with
  [ADR 0011](0011-repo-binding-is-repo-side.md)'s rejection of environment
  facts in `.mimir.toml`, resolved at the Norn-client phase gate (see the
  Refinement below); and how log-derived timestamps (ADR 0003's computed
  `became_ready_at`) are derived once the transition log lives in
  `## History`, resolved at the read-path phase.
- **The id↔int lookup layer thins:** the file stem is the id; the internal
  integer mapping disappears with the SQLite schema.
- **`docs/schema-reference.md` becomes historical at cutover**, replaced by
  the vault's frontmatter schema (Norn `validate.rules`) as the concrete
  data reference.
- **ADR 0010 is reread, not violated:** consumers still consume Mimir
  through its transports only; Mimir itself now consumes Norn through a
  transport rather than owning the substrate.

## Refinement (2026-07-02, MMR-136/MMR-142): the vault's location, layout, and bootstrap

The Norn-client phase gate resolved the deferred vault-shape items.

- **The vault path is an environment fact** — the same class as the SQLite
  store path, with the same treatment: `MIMIR_VAULT` env > `[vault] path` in
  the global config (`~/.config/mimir/config.toml`) > the build-profile
  default (`$XDG_DATA_HOME/mimir/vault` in production; the repo-local
  `.dev/vault` from source). `.mimir.toml` never names a vault; the ADR 0011
  tension dissolves rather than needing an exception.
- **Per-project directory layout** — `KEY/KEY.md` (the project document),
  `KEY/KEY-seq.md` (nodes), `KEY/artifacts/KEY-aN.md` (artifacts). Stems
  remain globally unique, so the layout is browsability, asserted
  structurally via the generated rules' `allowed_paths`.
- **Bootstrap is one idempotent convergence**, not create-vs-init modes.
  `converge(dir)` lands in one of three outcomes: **created** (absent or
  effectively-empty directory — scaffold, `git init`, initial commit),
  **converged** (a recognized vault — regenerate drifted rules, bump an
  older schema, re-init missing git; a no-op when current), **refused**
  (a non-empty directory without the identity marker, or a marker schema
  newer than the binary). Refusal is what structurally enforces this ADR's
  own-repo boundary — Mimir can never move into a knowledge vault.
- **`.mimir-vault.toml` is the identity marker and migration ratchet.** Its
  `schema` field is how a future binary that reshapes frontmatter or moves
  files converges older vaults forward, and how an older binary refuses a
  newer vault (the downgrade guard). Mimir owns `.norn/config.yaml`
  wholesale: regenerated on converge, hand edits overwritten.
- **Mount-safety:** runtime converge auto-creates only at the _derived
  default_ path. An explicitly configured path (env or config) that is
  absent is a startup error — `serve` fails fast and exits non-zero so
  launchd's KeepAlive retries until a late-mounted volume appears; a fresh
  vault is never silently scaffolded at an unmounted mountpoint. Creation
  at a custom path belongs to the interactive setup flow.
- **Commit cadence resolves to periodic snapshots**, not per-write commits:
  a `vault snapshot` command (commit-if-dirty, optional upstream pull/push)
  on a scheduled launchd unit, in the `service` family. Converge itself
  commits only what it owns — the scaffold, schema upgrades, and the
  baseline of a re-initialized history.

## Refinement (2026-07-04, MMR-162): node description is body-authoritative; a `summary` field carries the list lede

A node's full `description` prose was written to **both** the
`## Task Description` body section and a frontmatter `description` string, with
the frontmatter copy chosen as the read surface. Frontmatter is for short,
scannable, progressive-disclosure values; multi-line prose in a frontmatter
string misuses it, and Norn's YAML serialization is not round-trip-safe for such
values — a blank line in a multi-line scalar folds away on read. Markdown's body
is the correct home for prose.

- **The `## Task Description` body is the sole authoritative source of a node's
  description.** Frontmatter no longer carries `description` at all; the
  redundant, lossy copy is removed. The read path sources description through the
  `BodySectionStore` seam (the same seam that reads `## History` /
  `## Annotations`): the SQLite backend returns the column, the Norn backend
  slices the section from the document body.
- **Description leaves the bulk projection and the base view.** It is no longer
  part of the frontmatter working set every read bulk-loads; it is read per node
  on a detail `get`, not carried in `list` / `next` rows. This trades a
  cheap-everywhere frontmatter field for a per-node body read scoped to detail
  reads — accepted because bulk views want a short lede, not full prose.
- **A new `summary` frontmatter field carries the list lede.** Optional,
  node-scoped, a short single-line string (≤256 characters, hard-validated;
  embedded newlines stripped on write). It is **authored, never derived** — a
  truncation of the body would be a stored cache of derived content,
  reintroducing the sync burden this ADR's "derive, don't store" stance exists to
  avoid. `summary` rides the cheap frontmatter bulk load and is surfaced in
  `list` / `next`. `title` remains the primary identifier; `summary` is an
  independent optional line, absent (null) until authored — there is no title
  fallback.
- **Migration sets `summary` to null** for existing nodes (no derived
  truncation); the authoritative migration already writes the full description
  into `## Task Description`, so it stays lossless with the frontmatter copy gone.
- **Scope: nodes only.** Projects retain their (short) frontmatter `description`;
  they carry no `## Task Description` body section, and a project description body
  is out of scope until it is shown to be needed.

## Refinement (2026-07-05, MMR-161): the read contract for hand-edited body sections

The `## History` / `## Annotations` record grammar was designed for lossless
round-trips of _Mimir-written_ content — the write path escapes heading-shaped
body lines, so a record always parses back exactly. But this ADR makes markdown
the human-editable source of truth, so a hand edit (or a git merge, or another
agent) can leave content the write path never would. Two such hazards surfaced in
the MMR-154 review: a record whose body fails the strict H3 grammar (F2), and an
unescaped `### ` line inside a record body (F4).

- **Reads tolerate; they never throw.** A malformed record is skipped, not
  surfaced as an error — consistent with the frontmatter read path, which already
  drops a malformed document rather than failing the query. A single hand-edit
  typo must not brick a node's `get`, and the markdown on disk is never destroyed
  by a read, so the content remains recoverable by opening the file. (The core is
  transport-agnostic — shared by the CLI, MCP, and HTTP envelopes — so it has no
  channel to warn _into_ regardless.) Actively reporting corruption is a separate,
  additive concern (a future vault-lint/`check` surface, MMR-166), not a read-path
  behavior.
- **Record boundaries anchor on the full grammar, not a bare `### `.** A
  `## History` record opens on `### <at> — <kind>` where `<kind>` is a known
  transition kind; a `## Annotations` record opens on `### <ISO createdAt>`. A
  heading-shaped line that does not match the whole grammar — a `### notes` line
  typed into a reason, or a `### follow-up — see comments` line whose kind is not
  a transition kind — stays _content of its enclosing record_ instead of
  splitting one record into two and silently shedding the orphaned tail (F4).
  Both boundaries anchor at the same strictness: the annotation's ISO shape and
  the history record's known-kind constraint are each part of what opens a
  record. A hand edit that reproduces the full grammar is still read as a new
  record; that is inherent, since it is indistinguishable from a genuine one.
- **Vault-editing rules** (for a human or agent editing a node's markdown directly):
  - These sections are an **append-only log** — edit to correct, don't rewrite
    history; a dropped or reshaped record is a silent omission on read.
  - A record is one H3 block: `### <ISO> — <kind>` then a `<from> → <to>` edge
    line then an optional reason (History), or `### <ISO>` then free content
    (Annotations). `<kind>` must be a known transition kind; a heading whose kind
    is unrecognized (or whose timestamp is not ISO, for an annotation) is not a
    record boundary at all and reads as content of the preceding record.
  - To include a heading-shaped line (`#`..`######` + space) inside a reason or
    annotation body, prefix it with a backslash (`\### like this`) — the same
    escape the write path applies; it is stripped on read.

## Refinement (2026-07-05, MMR-164): the cross-node transitions feed is at-ordered best-effort, not byte-parity

The whole-portfolio transition feed (`/api/transitions`, ADR 0002/0003) is a
two-backend seam like history/annotations, but unlike them it **cannot** be made
byte-parity across backends. SQLite reads the append-only `transition_log` in
insertion (`id`) order; the Norn backend has no global log — it fans every
node/project `## History` section out of the vault and merges them, keyed by
`(at, stem, index)`. A markdown vault carries no global insertion sequence, so
this is the root constraint, not an implementation gap.

- **The feed's contract is `at`-ordered best-effort, and that is accepted.**
  Three divergences from the SQLite feed follow from the missing global sequence,
  all documented and accepted: (1) page **order** diverges under a non-monotonic
  `at` — a clock step-back, a backfilled/imported transition, a hand-edited
  `## History` — both across nodes on an equal `at` and within one node; (2) the
  `(at, stem, index)` resume **cursor** is not truly monotonic — a transition
  appended after a cursor was issued but stamped with an earlier `at` sorts
  before it and is skipped, where SQLite's `id > since` still delivers it; (3)
  each `list` **re-fans and parses the whole vault** — `since`/`limit` cannot
  push down, because `at` lives per-transition in the body, which Norn's `find`
  (a frontmatter query) cannot filter.
- **No durable per-transition sequence is added.** Fixing any of the three at the
  root requires a monotonic global sequence persisted in the vault (a
  per-transition `seq`, or an append-only transition-index document) — which
  reintroduces exactly the cross-doc coordination point ("allocate the next
  global number under concurrent writers") that this ADR's "markdown = truth, no
  global insertion sequence" premise exists to avoid. That cost is not paid for a
  surface **with no live consumer**: the UI's timeline is per-node (built from
  the node-detail history/annotations facets), the `/api/transitions` route is
  served but no client reads it, and the agent (MCP) envelope does not expose it.
- **A strict feed is a consumer-driven follow-up (MMR-168).** If a portfolio
  activity-stream consumer that needs exactly-once / insertion-order semantics
  ever lands, the durable-sequence design is revisited against that consumer's
  actual requirements — not speculatively now. Until then the A/B parity harness
  compares the two feeds as a **set**, not by page order.
- **Efficiency (F6):** the node-detail body-section reads are batched — a `get`
  assembling `description` + `annotations` + `history` fetches the node
  document's `.body` **once** and slices each section (`BodySectionStore`'s
  `readSections`), instead of one `.body` fetch per facet. This is orthogonal to
  the feed contract but was folded in with it.

## Refinement (2026-07-07, MMR-170): a `project` frontmatter field makes work-state docs scopable by `vault.find`

Norn's `vault.find` filters on **frontmatter fields and full-text**, not on the
document path. A node's owning project lived only in its `KEY-seq` stem (the file
path), so no `find` selector could scope work-state docs by project — the pattern
artifacts already use (`--eq project:KEY`) had no node equivalent. A scoped
`mimir doctor` therefore read the whole vault and filtered in memory.

- **Every work-state document carries a `project` frontmatter field, and it is
  required.** A wikilink to the owning project (`[[KEY]]`), self-referential on
  the project document, mirroring the artifact rule and `parent`. Declared
  `project: wikilink` and `required` in the node and project schema rules;
  `VAULT_SCHEMA` bumps `2 → 3`. Required is deliberate, not incidental: a scope
  query is only trustworthy if _every_ in-scope document answers it, and the
  self-referential value is what makes the **project document itself** findable
  by `--eq project:KEY`. This lets `find --in type:… --eq project:KEY` return a
  project and all its nodes in one query — the scope push-down `mimir doctor -s`
  now uses instead of reading the whole vault and filtering in memory.
- **The schema bump backfills existing documents; it does not merely declare the
  new shape.** A structural bump alone (regenerated rules + marker) would leave
  every pre-existing document missing a now-required field — invisible to the
  scoped query the field exists to serve. So the `2 → 3` converge runs a data
  migration ([`vault/backfill.ts`](../../packages/bin/src/vault/backfill.ts)):
  it finds documents `--missing project` and writes each one's value. The
  migration runs **first** — a throw-prone Norn side-effect under the still-current
  rules — and only once it succeeds are the regenerated rules and the bumped
  marker written **adjacently and committed together**. So a crash mid-backfill
  leaves the rules unwritten and the marker at the old schema (the backfill is
  idempotent, so the retry completes it), and a bumped marker can never land in a
  commit beside stale rules. converge gained a `migrateData` injection point so
  the fs/git-structural function stays client-free for its unit tests while every
  production caller performs the Norn-side rewrite (ADR 0018); an upgrade converge
  with no migrator **refuses** rather than advancing the marker over un-migrated
  documents.
- **The value comes from the stem, never the path.** The `KEY/…` directory layout
  is deliberately irrelevant to identity — only document _creation_ (`norn new`)
  constructs a path; everywhere else the stem resolves cleanly. The backfill
  derives a document's project key from its stem (`parseIdentity`), addresses the
  write by that stem, and never reads the directory. Deriving the key from the
  `KEY/` directory prefix would couple identity to the layout the vault is built
  to keep incidental.
- **The stem stays authoritative; `project` is a materialized query projection.**
  This does not add a second source of truth: the reader still derives a node's
  project from its stem and **ignores** the frontmatter field for correctness.
  The field exists solely so Norn's frontmatter-only query engine can scope — the
  same reason `parent`/`depends_on` are materialized as stems rather than
  recomputed. "Derive, don't store" governs _truth_ (the rollups and predicates
  that would drift); a queryable projection of a stem-derived identity is not
  that. A document whose `project` is present but hand-corrupted to a different
  key falls out of a _scoped_ `find` — a diagnostic-only, bounded edge (the
  reader is unaffected; `-s all` catches it). A stem-vs-`project` divergence
  check is a deferred follow-up (MMR-231), not load-bearing for correctness.

## Refinement (2026-07-07, MMR-232): the cutover — Norn is the default backend, SQLite is fenced

The final phase landed. The default `[store] backend` is now `norn`, so every
consumer reads and writes the markdown vault unless it explicitly opts out. The
body's "SQLite remaining the default backend until the final phase" is now
historical.

- **Non-destructive, idempotent migration.** `mimir migrate nodes` +
  `mimir migrate artifacts` reconstruct the whole live store into the vault (994
  nodes/projects = 983 + 11, plus 66 artifacts) at literal `KEY-seq` stems,
  without writing to SQLite. The vault is a new artifact built alongside the
  source store, so a re-run converges rather than duplicating.
- **The migration is proven lossless two ways.** (1) The A/B harness
  (`parity.integration.test.ts`, `MIMIR_PARITY_LIVE=1`) proves migration
  losslessness _in principle_: it re-migrates a snapshot copy into a throwaway
  vault and asserts a byte-lossless round-trip of the **node graph** — the
  working set plus every node's `## Task Description` / `## History` /
  `## Annotations` body section (the cross-node transitions feed is set-equal,
  not byte-order — MMR-164). Artifact **content** losslessness rides its own
  oracle (`core/artifacts/conformance.test.ts`, both backends), not this run.
  (2) The **live vault actually flipped to** was verified directly: identical
  `list --status all` id-sets between the Norn and SQLite backends across all 11
  projects, per-project file counts reconciling exactly (1060 files = 994 + 66),
  and a clean `mimir doctor` (which surfaces any ADR-0017 `dropped[]` node, so a
  silent drop would show). A silent lossy migration is the only real hazard the
  non-destructive design carries; these two checks are the go/no-go for the flip.
- **SQLite is fenced, not deleted — but "untouched" is imprecise.** It stays
  reachable via an explicit `[store] backend = "sqlite"` (or
  `MIMIR_STORE_BACKEND=sqlite`), and its **data** is frozen: a write on the Norn
  backend does not reach it (verified — post-flip Norn writes are absent from the
  SQLite store). It is not literally untouched, though: `main.ts` still opens and
  `migrateToLatest`-migrates the SQLite db on every command regardless of backend
  (the schema advances; the data does not), because the store must stay openable
  as the rollback. Eliminating that needless open on the Norn path is tracked
  (MMR-236). Rollback is a one-line flip back to `sqlite`, clean **up to the
  cutover point** — any work done on the Norn vault after the flip is not
  mirrored into SQLite, so a rollback forfeits it. Deleting the store and
  removing the fence is deferred to a soak-gated follow-up (MMR-234).
- **The flip is environment configuration, not a binary-default change.** The
  built-in fallback in `storeBackend()` remains `sqlite`
  (`config.store.backend ?? 'sqlite'`); only this host's
  `~/.config/mimir/config.toml` selects Norn. A consumer that does not read that
  config (a fresh install, a clean-env agent, CI) still defaults to SQLite —
  acceptable while the vault is single-host, and the built-in default flips with
  SQLite retirement (MMR-234). The `[vault] path` is set explicitly (fail-loud):
  an absent configured path errors rather than silently scaffolding a fresh empty
  vault — the mount-safety rule (`resolveVault`) that only the derived default
  path may be auto-created at runtime.

## Refinement (2026-07-15, MMR-196): plan-CAS is the sole write mechanism for every create — the ordered fallbacks era ends

The body's "Write path: plan-CAS as the north star" bullet carried a transitional
clause: until the plan surface covered creates, an ordered fallback applied —
create-exclusive retry over a client-derived `max(seq)+1` id allocation. Node
creation retired that first (MMR-153): a node is one `create_document` op whose
path carries a trailing `{{seq}}` token that Norn resolves to the next free
per-project sequence at apply time. Artifact and seed creation were the two
remaining derive-loop sites; they now ride the same token
(`KEY/artifacts/KEY-a{{seq}}.md`, `KEY/seeds/KEY-s{{seq}}.md`). With that, the
create-exclusive-retry-over-derived-`max(seq)+1` fallback is fully historical:
plan-CAS is the sole write mechanism for ALL creates, and Norn's `{{seq}}` token
is the single id-allocation authority.

- **No client-side allocation survives.** No create path derives an id by
  `max(seq)+1` over a read of sibling stems, runs a bounded create-exclusive
  retry loop, or issues a `vault.new` second write. The apply report echoes the
  resolved `KEY-aN` / `KEY-sN` stem, which each store decodes inline for its
  create echo — the same way the node write path reads a resolved node stem back.
- **Allocation is per-directory and by filename.** `{{seq}}` resolves next-free
  against the literal template prefix within the create's target directory, by
  filename — so an unparseable or foreign-typed sibling in that directory still
  occupies its number (no reuse), while a hand-misplaced document in a different
  directory does not contaminate the count. A resulting cross-directory duplicate
  stem is left to the fail-closed tolerant reader and `mimir doctor` (ADR 0017),
  not guarded at the allocator.
