---
title: 'ADR 0032: SQLite is the local tier, beside Postgres, on one shared SQL store'
description: Replace the Norn backend with a SQLite local tier that shares one dialect-parameterized SQL store with the Postgres hosted tier, and remove Norn outright.
status: accepted
date: 2026-10-03
---

# ADR 0032: SQLite is the local tier, beside Postgres, on one shared SQL store

Mimir keeps two store backends, split by role. **SQLite** is the local tier:
the default, with no external runtime dependency. **Postgres** is the hosted
tier for durable, shared operation ([ADR 0030](0030-postgres-store-backend-shared-store-bridge.md)).
Both run on one SQL store, written once against Kysely and parameterized by
dialect. The Norn backend is removed outright. This supersedes
[ADR 0016](0016-norn-vault-system-of-record.md) and
[ADR 0018](0018-vault-access-is-norn-only.md).

## Context

Mimir began on a SQLite store. ADR 0016 retired it (MMR-234) and made a
Norn-managed markdown vault the system of record, so work state would be
human-readable, git-versioned, and owned by Norn's index. ADR 0030
then added Postgres for multi-machine work, and the live boards moved to it.
After that cutover, the Norn backend served no live board, yet it carried most
of the store's maintenance cost:

- **A coupled external binary.** Every install needs `norn` on PATH, at a
  version Mimir does not control. CI pins one version; a local install runs
  whatever is installed, so a Norn release can break Mimir writes at runtime.
- **Substrate work Mimir cannot finish alone.** Unindexed lookups, schema
  converge, validation-finding reporting, and plan-format changes each needed
  work on both sides of a process boundary.
- **A second store with a different shape.** The Norn store is document- and
  plan-based; the Postgres store is relational. Every `Store` seam change landed
  twice, in two unrelated implementations.

Most of the Postgres store's query code is plain Kysely builder code that
SQLite can run. Its Postgres-only parts are narrow: the serializable
transaction and retry policy, the catalog probe and advisory lock in the
migrator, the DDL, and the deferred-constraint switch during import.

## Decision

1. **Two tiers.** SQLite is the local tier and the default backend: one
   database file in the installation's resolved data directory, as
   [ADR 0031](0031-installation-authority-and-disposable-development.md) binds
   those directories, with no external binary. Postgres is the hosted tier, selected by
   `[store] backend = "postgres"` exactly as ADR 0030 describes. Neither tier
   replaces the other.
2. **One shared SQL store.** The query code (working set, writer, artifacts,
   seeds, scratchpads, transitions, transfer) is written once. Each backend
   opens its own connection; a dialect seam supplies the transaction and retry
   policy, the schema-version probe and upgrade lock, the DDL, and the column
   encodings and error codes that differ by driver. A seam change lands once,
   and the conformance suite runs it against both dialects.
3. **SQLite's write and schema posture.** The SQLite dialect runs in WAL mode
   with foreign keys enforced and a busy timeout, and opens write transactions
   with `BEGIN IMMEDIATE`, so concurrent local processes such as the CLI and
   `mimir serve` serialize on the database lock. A local database migrates
   forward on open, inside a transaction, so a failed migration leaves the old
   schema intact. A binary refuses a database whose schema is newer than its
   own. Postgres keeps its explicit `mimir store upgrade` gate.
4. **Norn is removed outright.** The Norn store, vault converge and backfill,
   `vault snapshot` and its timers, the Norn doctor checks, the `[vault]`
   configuration, `MIMIR_VAULT`, `MIMIR_NORN`, and every CI Norn install leave
   in the release that ships the SQLite tier. There is no deprecation cycle.
5. **Migration is export, then import.** The transfer document is
   backend-neutral and versioned. An existing Norn vault moves with
   `mimir store export` on the last release that carries the Norn backend, then
   `mimir store import` after the upgrade. The release that removes Norn carries
   no Norn reader.
6. **Backup is `store export`.** With the git-backed vault gone, the backup for
   either tier is the transfer document. Copying a live WAL database file is not
   a supported backup.

## Considered and rejected

- **Revive the retired SQLite store.** It predates seeds, scratchpads, and
  transfer, and implemented a smaller seam. The new tier builds on the Postgres
  store's current schema and seam instead.
- **Keep Norn as the local tier and pin its version.** A pin removes surprise
  upgrades but keeps the external binary, the process boundary, and the second
  store shape.
- **Bundle a pinned Norn inside Mimir.** Removes the PATH dependency, but keeps
  the coupling and adds per-platform binary packaging.
- **PGlite as the local tier.** It needs almost no new store code, but allows one
  process at a time per data directory, so the CLI and a running `mimir serve`
  could not share a local store.
- **A separate SQLite store copied from the Postgres store.** Faster to start,
  but two copies of the query code drift, which is the cost this decision
  removes.
- **Deprecate Norn for one cycle before removal.** No live board runs on Norn,
  and the export-then-import path already exists, so a cycle would only extend
  the coupling cost.

## Consequences

- The local tier gains transactional write safety. ADR 0023 already scoped its
  declined-write-safety posture to the Norn backend; that posture retires with
  Norn, and both tiers now declare cross-writer atomicity. Its single-operator
  framing still holds.
- Work state is no longer human-readable on disk or versioned in git. Readers
  use the CLI, MCP, HTTP, and console surfaces; `store export` produces a
  readable document.
- ADR 0017's tolerance for hand-edited or malformed documents loses its main
  source, because nothing edits the database outside Mimir.
- ADR 0009, which adopts Norn's output and selection conventions for the CLI,
  is unaffected. It governs Mimir's own output, not the store.
- The 2026-10-03 refinement in ADR 0030, which accepted Norn's automatic schema
  upgrade, becomes history once Norn is removed.

## Changelog

- 2026-10-03: Clarified that each backend opens its own connection and the dialect seam carries column encodings and error codes (MMR-416).
