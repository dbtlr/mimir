---
title: 'ADR 0017: Runtime data-tolerance; doctor is a non-gating diagnostic'
status: accepted
date: 2026-07-05
---

# ADR 0017: Runtime data-tolerance; doctor is a non-gating diagnostic

> **Status update (2026-07-12, MMR-234): implemented.** With the SQLite backend
> retired, the Norn-managed vault is the sole store, so the data-tolerant reader
> and the single shared validator described here are the only path — there is no
> longer a typed-row backend whose FKs/CHECKs would preclude the corruptions
> doctor surfaces.

Refines ADR 0016. Under a Norn-managed markdown vault, the durable record is
hand-editable and integrity is not enforced by a database — so corruption
(a dangling reference, a missing project, a relational cycle, a malformed body
record) is a real possibility, whether from a hand edit or a write-path/storage
bug in a pre-1.0 system. The live reader must not fail loud on it: a single bad
record would otherwise take the entire read path down (`list`/`next`/`get`/`tree`
all break on one throw).

**Decision.** The live vault reader is **data-tolerant**: it drops invalid nodes,
edges, and references to them and emits a **valid, self-consistent subgraph** —
it never crashes and never silently computes over bad data. A single **shared
validator** is the one source of truth for what is invalid; the reader drops
from it and `mimir doctor` reports from it. Doctor is a **non-gating diagnostic**:
it always exits `0` when it runs successfully — its job is to surface issues, and
doing so _is_ success — and per-finding `error`/`warn` is an informational triage
label only, never an exit-code gate.

- **Tolerate, never crash.** Any read yields a valid closed subgraph. Invalid
  data is absent, not fatal.
- **Never silently wrong.** The reader either shows a node correctly or drops it
  — it never includes bad data and derives a wrong answer over it. Dropping a
  node also drops references _to_ it (a link to a hidden node disappears);
  referencing nodes survive minus that link — a bounded cascade, not a runaway.
- **Drop taxonomy.** Edges loosen (a dangling/cyclic `parent` or `depends_on`
  edge is dropped, the node stays); a missing _container_ hides the node (a node
  whose project has no document is dropped, together with its project siblings,
  since there is no valid place for it to live).
- **Single source of validity.** One validator, `validate(rawGraph) → { valid
subgraph, dropped[] with reasons }`. The reader consumes the valid subgraph;
  doctor renders `dropped[]`. The reader's drops and doctor's findings are the
  same truth viewed two ways — never two parallel detectors that can drift.
- **Doctor is non-gating.** Always exits `0` on a successful run regardless of
  findings; a nonzero exit is reserved for doctor itself failing (vault
  unreachable, backend error). Findings are the output, not the status.

**Consequences.**

- Supersedes the exit-code behavior established for `mimir doctor` (an `error`
  finding no longer gates with a nonzero exit); severity becomes informational.
- The standalone referential detectors (dangling references, missing project)
  converge into the shared validator rather than remaining separate raw readers.
- Relational acyclicity — the one corruption the resolving reader silently
  accepts today rather than throwing on — becomes a validator rule: the reader
  drops the cycle-closing edge and doctor reports it.
- Makes the Phase-4 cutover safe: the live reader stays stable on a vault the
  database can no longer vet.

**Out of scope (deliberately deferred, post-cutover).** Automated repair
(`doctor --fix`) — including the non-trivial recover-vs-delete question for a
missing container — gets its own decision. An aggregate issue-count trailer on
`mimir next` and a UI issues surface are enhancements, not part of this contract.
