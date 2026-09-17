---
title: 'ADR 0030: A Postgres store backend, selected per install, bridges to multi-machine work'
status: accepted
date: 2026-09-16
---

# ADR 0030: A Postgres store backend, selected per install, bridges to multi-machine work

Mimir gains a second `Store` backend on Postgres. The backend is selected per
install by configuration; the Norn-managed markdown vault (ADR 0016) stays the
default, local backend. A Postgres install shares one database among every
machine that runs the binary, and the database transaction is the write
authority. Migration between backends is an export/import pair on the `Store`
seam.

## Context

The forcing function is concurrent agent work on more than one machine against
one board. That requires a single write authority. The planned 1.0
client/host architecture supplies one (the host is the only writer) but reaches
it only after the codec extraction, the engine port, the host artifact, the
wire, and auth, none of which has started.

Three paths were weighed against the code:

- **Remote Norn.** `norn mcp` is a stdio server, and writes require a
  canonicalizable local vault root. Not available from Mimir's side.
- **A remote CLI over the existing HTTP API.** The server side exists: every
  uniform verb is generated as an action route from the operation registry
  (ADR 0025), and every other work verb has a route. The client side does not:
  the CLI renders core return values, while the API returns ADR 0012 resource
  envelopes. A remote mode in the current CLI would re-plumb every verb's
  rendering, which is the 1.0 engine-port and wire work under another name.
- **A git-synced vault.** No atomicity between machines. ADR 0023 declines
  cross-writer guarantees on the markdown substrate by design.

Postgres is the remaining path. The 1.0 plan already names a Postgres store as a
host-private backend behind the `Store` port; this decision runs that same
backend under many embedded engines instead of one host. That is sound because a
serializable transaction supplies the serialization the host would otherwise
supply. When the host arrives, the backend moves behind it unchanged.

The cost is bounded by prior art. The SQLite backend retired at MMR-234
(`8f77c1a`) was a Kysely store with real transactions and a per-project sequence
counter; Kysely speaks Postgres natively. The writer seam it implemented has
grown by one method since. The config layer kept a reserved, empty `[store]`
section for the backend fence to return to.

## Decision

1. **Two backends behind a config fence.** `[store] backend` selects `norn`
   (default) or `postgres`. The fence is per install, never per project: the
   working-set load is deliberately whole-store because dependency edges cross
   project boundaries, so one install is wholly on one backend.
2. **Guarantees are backend properties.** ADR 0023's posture holds for the Norn
   backend. The Postgres backend provides cross-writer atomicity: every
   `transact` is one serializable SQL transaction, retried whole on
   serialization failure, and sequence allocation is a locked increment on the
   project row. The per-field CAS protocol of the Norn writer is not ported.
3. **One truth per install, no mirroring.** A Postgres install has no markdown
   vault behind it. Dual writes would reintroduce the sync problem the tool
   exists to remove.
4. **Migration is export/import on the seam.** Every backend can export its
   stored facts into one backend-neutral document and import such a document
   with identity (ids, sequences, timestamps) preserved. Import also leaves
   the target's allocation state consistent with the imported identities for
   every per-project sequence kind (node, artifact, and seed, per ADR 0006),
   so the next create after an import never yields an identity present in the
   import. On Postgres the transfer document carries each project's counters,
   and import writes each counter to the greatest of the carried value, the
   highest imported sequence of that kind, and, on resume, the counter already
   in the target. On Norn it is implicit: the imported
   documents are the allocation state, and an interior gap in the export is a
   freed number Norn may re-hand, ADR 0006's accepted edge, not a collision.
   Only stored
   facts cross the seam; status words, rollups, and predicates are recomputed
   on the target (ADR 0001). The document doubles as a portable backup.
   A fresh import requires that no imported project already exists on the
   target. Failure follows each backend's own contract: on Postgres the whole
   import is one transaction, so a failure leaves nothing and a retry is a
   fresh import again; on Norn it is partial success per ADR 0023, and a
   retry is an explicit resume that skips every document already present at
   its canonical path with content identical to the export and refuses on a
   present document that differs. Resume cannot duplicate because every
   imported identity is a canonical path, and the Norn allocator needs no
   recovery because it derives from the directory.
5. **Schema authority is explicit on the shared backend.** The Postgres backend
   carries a schema version. A binary refuses to run against a newer schema and
   upgrades an older one only through an explicit command. Norn's auto-converge
   is unchanged (MMR-362 stays open for that backend).
6. **Machinery is backend-provided.** Doctor, converge, and snapshot belong to
   the backend that owns the store. The composition root exposes a
   backend-provided doctor facet instead of Norn-typed plan members.

## Considered and rejected

- **Postgres as the only backend**, with an in-process Postgres for local use.
  One implementation is attractive, but it retires markdown truth, Obsidian
  visibility, and git history for single-host installs, which keep their value.
  Retiring Norn is a separate decision to take after living on Postgres.
- **A per-project fence.** Cross-project dependency edges would span two
  stores; the whole-store working set cannot derive across them.
- **Porting the CAS co-write protocol to SQL.** Transactions make it redundant;
  carrying both mechanisms would be two ways to land one change.
- **A one-way vault-to-Postgres migration command.** Both backends implement
  the seam, so a symmetric export/import pair costs little more and serves any
  future backend.

## Consequences

- Every seam change lands in two backends. The conformance suite is what holds
  them behaviorally identical; it runs against both. It includes an
  import-then-create case: after importing records with existing sequences,
  it creates one node, one artifact, and one seed on the same project and
  checks that none collides with an imported identity of its kind.
- Postgres tests run on an in-process Postgres so the ordinary suite needs no
  database service; one integration lane against a real Postgres guards
  dialect drift.
- The bridge provides no wire, no auth beyond the database's own, and no binary
  version gate other than the schema gate. A network outage is a hard failure
  for a Postgres install; there is no offline mode.
- Phasing: (A) restore the fence, make doctor backend-provided, add export and
  import with Norn implementing both; (B) the Postgres backend from the retired
  SQLite store, with the schema gate and the conformance suite over both;
  (C) the export and import commands and the cutover of existing boards.
- ADR 0016, ADR 0020, and ADR 0023 carry dated refinements pointing here;
  the ADR 0020 one retires its "Norn-backed only" note on the seeds seam,
  which described the retiring SQLite backend rather than the seam. ADR 0018
  is unchanged: Norn-only access holds within the Norn backend. ADR 0010 and
  ADR 0011 are unchanged for the bridge.
