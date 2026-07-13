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

> **Refinement (2026-07-13, MMR-183): deterministic repair.** Bare `mimir
doctor` remains the read-only, non-gating diagnostic decided here. The CLI may
> additionally invoke `mimir doctor --fix [--dry-run]`, a conservative repair
> pass over the same structured findings and one whole-vault snapshot. This
> refinement resolves the automated-repair deferral below without turning reader
> containment into permission to delete durable data.

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
- **Repair is explicit and structurally bounded.** `--fix` supports only four
  uniquely implied changes: normalize CRLF bodies; restore the query-only
  `project` projection from the canonical stem; add an exact missing `## History`
  or `## Annotations` heading; and recover an absent project document as an
  archived container with a valid archive-history record. Every other issue code
  has an explicit stable skip disposition. In particular, tolerant-reader drops
  of edges, nodes, fields, or body records are not persisted as deletions or
  invented defaults.
- **Canonical identity is the write boundary.** Repair scope comes from the stem's
  project key, never the possibly corrupt `project` frontmatter. A recovered
  project is created only at `KEY/KEY.md`; an occupied canonical path is skipped,
  never overwritten.
- **One snapshot, one atomic plan, then proof.** Repair derives one Norn migration
  plan from one diagnostic snapshot, carrying full-document hashes and
  expected-old values as CAS preconditions. Dry-run asks Norn to validate the plan
  without writing. Confirmed repair applies once, then rediagnoses the canonical
  scope; only absent post-image issues are reported fixed.
- **Repair failure is operational.** Unsupported residual findings are
  informational and preserve exit `0`. Planning failure, Norn refusal or drift,
  apply failure, and failed post-image verification exit nonzero. This does not
  change bare doctor's successful exit-0 contract.
- **Operator-only surface.** Repair is CLI-only. HTTP, MCP, and the console retain
  the read-only diagnostic projection; no ambient service receives a repair
  mutation capability.

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

**Still out of scope.** Semantic repair of references, lifecycle/signal values,
duplicate identities, malformed records/frontmatter, or ambiguous sections;
generic closest-match repair; an aggregate issue-count trailer on `mimir next`;
and a repair surface in HTTP, MCP, or the console. A future semantic recipe must
refine this decision explicitly rather than broadening `--fix` by default.
