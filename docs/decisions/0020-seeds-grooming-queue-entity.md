---
title: 'ADR 0020: Seeds — the grooming-queue entity'
status: accepted
date: 2026-07-08
---

# ADR 0020: Seeds — the grooming-queue entity

A **seed** is a record filed against a project that implies **no work — only
triage**. It is the intake for the grooming queue: a request, idea, bug, or
feature that either germinates into work or does not. A seed carries `{ project
(required), kind, lifecycle, requester?, spawned[], title }` plus a body
(`## Seed Description` + `## History` + `## Annotations`), and lives at
`KEY/seeds/KEY-sN.md`, sibling of `KEY/artifacts/`.

- **A project-anchored, non-tree entity** — the artifact-model sibling ([ADR
  0004](0004-artifact-model-project-anchored-flexibly-linked.md)): anchored to
  exactly one project, its own `KEY-sN` id grammar, and **not** a node in the
  work tree (it has no lifecycle-derived status, no rank, no parent).
- **`kind` is a required, closed schema field** (`idea | bug | feature`), not a
  tag.
- **`lifecycle`** is `new → promoted | resolved | rejected` (and `promoted →
resolved | rejected`). Terminal states are set **only by explicit triager
  verbs**, never derived from spawned work.
- **`requester` is a nullable project key** (null = self-filed at the target
  board).
- **Cross-board linkage is reference-only in v1**: a new nullable `upstream`
  field on **tasks** holds a seed id (`KEY-sN`), the requester-side pointer.

## Why

- The grooming queue is a distinct shape from work. Folding intake into the task
  tree would give every rough idea a lifecycle-derived status, a rank, and a
  place in the hierarchy it hasn't earned — triage is exactly the decision of
  _whether_ something becomes work. A seed is a first-class record with its own
  small lifecycle, kept out of `mimir next` (seeds are not work).
- **Artifact precedent fits.** Like an artifact, a seed is project-anchored,
  addressed by an external `KEY-sN` stem (no surrogate id crosses the seam), and
  carried as a markdown document the Norn vault owns. Reusing that shape — a
  storage seam parallel to `Store.artifacts`, derived `max(seq)+1` allocation,
  the shared history codec for the body — is the KISS path and inherits the
  vault's tolerance model ([ADR 0017](0017-runtime-data-tolerance.md)) for free.
- **`kind` is intrinsic classification, so it is a field, not a tag.** [ADR
  0005](0005-grouping-axis-is-tags.md) makes tags the _cross-cutting grouping_
  axis and forbids Mimir interpreting structured tag values. But the feature
  itself interprets a seed's kind (capture pills, a promote home-suggestion,
  queue chips), so kind is an intrinsic property of the seed, not a grouping over
  seeds — ADR 0005 does not apply. A closed enum also gives the validator real
  coverage (a foreign kind drops the record, surfaced by `mimir doctor`).
- **Terminal states are explicit, never derived from spawned work.** All of a
  seed's spawned tasks can be abandoned without the request being satisfied, and
  "already fixed / already exists" is a _resolution_ straight from `new` with no
  spawned work at all. Deriving a terminal from spawn-settlement would be
  routinely wrong. Spawn-settlement is an _attention signal_ ("ready to
  resolve"), surfaced by the triage pass — never an auto-close.
- **Reference-only cross-board linkage keeps v1 small.** `upstream` records "this
  task answers that seed" for the requester side; blocking on it stays the
  operator's explicit `block`/`unblock`. A gating cross-project dependency (the
  seed's terminal state auto-unblocking the requester task) is deferred until the
  reference form proves it earns the machinery.

## Considered and rejected

- **A seed as a task type / tree node** — inherits status derivation, rank, and
  hierarchy that triage explicitly hasn't decided; pollutes `mimir next` with
  non-work. The whole point of a seed is that it is _not yet_ work.
- **`kind` as a tag** — Mimir would have to interpret a structured tag value
  (`kind:bug`), which [ADR 0005](0005-grouping-axis-is-tags.md) forbids, and the
  validator could not enforce a closed set. Rejected for the same reason the
  artifact `type` enum became tags but this one does not: kind is _interpreted by
  the feature_, so it is intrinsic, not grouping.
- **`disposed` as the terminal word** — `resolved` is honest across all three
  kinds (an idea can be resolved as "won't do", a bug as "fixed", a feature as
  "shipped") and leaves `settled` free as the generic terminal-group word.
- **Deriving terminal state from spawned work** — wrong whenever spawned tasks
  are abandoned or when a seed resolves with no spawned work; see Why.
- **A gating cross-project dependency in v1** — real machinery (cross-board edge
  resolution, archived-prerequisite semantics) for a link whose reference form
  isn't yet proven. Deferred; `upstream` + explicit block/unblock ships first.
- **`upstream` as a tag or reusing `external_ref`** — `external_ref` keeps its
  job (outward GitHub linkage); a tag would again make Mimir parse a structured
  value. A dedicated nullable field, validator-enforced against the `KEY-sN`
  grammar, is the honest shape.

## Consequences

- New id grammar `KEY-sN` joins `parseIdentity` alongside `KEY-seq`/`KEY-aN`; a
  new `Store.seeds` seam parallels `Store.artifacts`, **Norn-backed only** (the
  retiring SQLite backend throws — seeds are never stored there, MMR-234).
- The store owns the lifecycle machine and terminal-freeze: `patch` (title / kind
  / description) refuses a terminal seed; `transition` refuses an illegal edge
  and records the move in `## History`; `create` and `germinate` (the promote path's
  single atomic plan — spawned link + `new → promoted` + `## History` in one write)
  complete the mutation primitives. `requester` and `spawned` are verb-owned, never
  hand-patched.
- Tasks gain a nullable `upstream` column (`KEY-sN`), round-tripping like
  `external_ref`.
- The shared validator ([ADR 0017](0017-runtime-data-tolerance.md)) gains seed
  coverage, all surfaced by `mimir doctor` with no doctor-specific logic. Only
  `kind`/`lifecycle` are acted on at read time — a foreign/missing value drops the
  seed **record** (the store's `toRecord` reads it as absent). The referential
  rules — a missing own-project (record), an unknown `requester` (field), a
  dangling `spawned` (edge), a dangling task `upstream` (field) — are **validator/
  doctor-only**: the seed store reads them verbatim, and the resolution that acts
  on them lands at the consumer's read seam (MMR-245). The one thing the reader
  nulls **locally**, with no seeds loaded, is a malformed (non-`KEY-sN`) task
  `upstream` — the grammar tier, exactly as a foreign priority/size nulls.
- The verb surface (CLI/MCP/HTTP: `seed` / `seeds` / `promote` / `reject` /
  `resolve` / `triage`) and the triage reconciliation pass ride on top in
  follow-up work (MMR-245 / MMR-246); this ADR settles the entity + schema.

## Refinement (2026-07-08, MMR-245): the resolving read seam + verb surface landed

The verb surface reads seeds through one shared resolving seam
(`listSeeds`/`getSeed`), mirroring how the node reader consumes `validate`'s valid
subgraph. That seam is now the second reader that the referential rules act on: it
**nulls an unknown `requester`** and **prunes a dangling `spawned`** ref (and hides
an orphaned seed), and it derives `readyToResolve` live. With a real reader
dropping/nulling those, the `mimir doctor` severities were made truthful — dangling
`spawned` and unknown `requester` are `error` (the reader drops/nulls them), a
malformed task `upstream` stays `error` (nulled locally), and a **dangling** task
`upstream` became `warn`: it is reference-only (ADR's block/unblock is the
requester's explicit act), no reader drops it, so it is surfaced for repair, not lost.

**Archived-visibility semantics (this round).** The seam extends ADR 0015 hiding to
seeds, consistently on both the write and read sides:

- **Mutations are refused on an archived board.** `update`/`reject`/`resolve`/
  `promote` assert the seed's own board is active before any write (and, for
  `promote`, before `createTask`), reusing the node write-lock's
  `conflict('project X is archived — no changes are allowed')` — so a frozen board
  never mutates and `promote` never orphans a task.
- **Archived spawned work is hidden from the facet but counts as settled.** A
  `spawned` ref whose board is since-archived reads as absent (dropped from the
  displayed `spawned[]`), yet `readyToResolve` is derived over the _unpruned_
  survivors treating an archived-board node as settled (archiving is a stronger
  "over" than done — the ADR 0015 refinement on prerequisites). So the attention
  signal survives archiving and reverts on unarchive.
- **An archived `requester` is nulled on read** (the seam's active-only visibility),
  and `mimir doctor` reports it as a distinct `archived-requester` **warn**
  ("requester X is archived — nulled on read (reverts on unarchive)"), separate from
  the unknown-requester `error` — the value reverts on unarchive, it is not corruption.

The seam also single-sources the seed **lane** (untriaged/ready/promoted/settled,
`ready` winning over `promoted`), exposed on the wire so the web UI and MMR-246
derive nothing; `get KEY-sN`, the queue's `project=all` selector, and the promote
echo's sibling `created` (the spawned task id) are honored identically on CLI, MCP,
and HTTP.
