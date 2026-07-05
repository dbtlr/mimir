---
title: 'ADR 0016: A Norn-managed markdown vault is the system of record'
status: accepted
date: 2026-07-01
---

# ADR 0016: A Norn-managed markdown vault is the system of record

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
  except rank reindex, the one genuine multi-document operation, which the
  plan surface already applies atomically.
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
