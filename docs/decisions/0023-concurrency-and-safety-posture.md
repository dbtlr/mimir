---
title: 'ADR 0023: Concurrency and safety posture — Mimir is not a write-safe datastore'
status: accepted
date: 2026-07-14
---

# ADR 0023: Concurrency and safety posture

Mimir is a local-first work-state tool, not a transactional database. Its
substrate is a Norn-managed markdown vault (ADR 0016) that is hand-editable,
snapshot-versioned, and shared with any other process the operator points at
it. Several review threads have asked Mimir to guarantee that a create or a
logical-stem mutation cannot race a second, independent writer — to make
work-state identity globally unique under concurrency. This ADR records that
Mimir **declines** that guarantee, and why, so the question stops being
re-derived as a defect each pass.

**Decision.** Mimir does not attempt write-safety against concurrent or
external writers. The posture rests on three accepted facts about the tool:

1. **Single operator, many agents.** A vault has effectively one human owner,
   though many agents may act on that owner's behalf. Mimir serializes the
   writers it owns and fails closed when it detects an identity collision; it
   does not build a coordinator to make independent writers globally atomic.
2. **Norn reports, it does not block.** Norn's role at a conflict is to
   surface and help identify it — not to enforce mutual exclusion. There is no
   global lock authority in the substrate, and Mimir does not ask Norn to grow
   one (see "Bounds on ADR 0018" below).
3. **No authority over direct filesystem writes.** The vault is hand-editable
   and open to other processes. Mimir cannot police a writer it does not
   control, so it does not pretend to.

From these: **`doctor` remediates, it does not prevent.** Its job is not to
stop the operator (or a stray writer) from doing something wrong — it is to
help find and fix it afterward. Prevention Mimir cannot enforce is not
promised at the write path; detection and repair (ADR 0017) are the contract.

**Concurrent-writer atomic identity uniqueness is explicitly out of scope.**
Mimir guarantees deterministic, fail-closed behavior for the writers it
serializes and for any collision it can observe in a snapshot; it does not
guarantee that two independent writers cannot momentarily mint the same
canonical stem or project key. When that happens, the collision is detectable
and `doctor` surfaces it — that is the whole of the promise.

**Where identity derives its own path, a create cannot fork it.** A supplied
identity *is* a canonical path: a project key maps to one document
(`KEY/KEY.md`). Two concurrent creates of the same key therefore contend on a
single file, not two — the filesystem collapses them and the result is
identical. An allocated identity (a node or seed sequence, handed out uniquely
by Norn during apply) does not collide at all: two creates get two sequences.
The only way one identity occupies *two* files is a non-canonical physical
placement — a hand edit or an external move — which is precisely the
out-of-authority case above. So the "duplicate project key" that motivated the
rejected options below is not even a product of a concurrent create through
Mimir; it is a hand-edit corruption `doctor` reports.

## Bounds on ADR 0018

ADR 0018 makes a capability gap "evidence of a missing Norn capability" —
the default response being an ask filed with Norn. That escalation rule holds
for **content operations** (encoding, section grammar, apply atomicity for a
single writer). It does **not** extend to cross-writer coordination. A missing
global-uniqueness or reservation primitive is not a Norn ask to file: it is a
guarantee neither system provides, because a filesystem-backed, hand-editable
markdown vault has no place to host a global lock authority without becoming a
different kind of system. Declining the guarantee is the decision, not
deferring it to Norn.

## Considered and rejected

- **A Norn-side uniqueness/reservation primitive or original-create-hash CAS
  delete** (the shape MMR-274 tracked). Asks a knowledge-vault substrate to
  become a transaction coordinator with a global lock authority — against
  Norn's model (per-document CAS, path-addressed apply) and its topology
  direction. Rejected as out of Norn's remit and unnecessary at single-operator
  scale — and, for the duplicate-project-key case it was raised against,
  guarding a collision that a canonical path already prevents (both creates
  resolve to `KEY/KEY.md`; the result is one identical document).
- **A Mimir-side write coordinator** — a daemon-as-sole-writer or vault-wide
  advisory lock that serializes every mutation. It would close the
  Mimir-vs-Mimir window, but the only race left after Mimir already serializes
  its own writers is Mimir vs. a non-Mimir process, which a Mimir-owned lock
  cannot bind. Rejected as over-engineering: real cost, no guarantee against
  the actor that motivates it.
- **Atomic logical-stem preconditions for seed apply/new** (the shape MMR-275
  tracked). Same class as MMR-274 — a reservation or logical-target operation
  Norn does not expose and would have to become a coordinator to expose.
  Rejected on the same grounds; the residual race is detectable and
  `doctor`-visible.

Both MMR-274 and MMR-275 are abandoned; this ADR supersedes the premise behind
them — that the gap is a bug to fix rather than a boundary to accept.

## Consequences

- Review should treat a detectable-but-unpreventable concurrent-writer race as
  in-scope-by-design, not a finding. A future proposal to add write-safety must
  refine this decision explicitly, with the operator scale that now justifies
  it.
- The write path keeps its existing guarantees: it serializes the writers Mimir
  owns, fails closed on an observed collision, and never claims a serialization
  it cannot provide.
- `doctor` remains the remediation surface for identity collisions and other
  corruption (ADR 0017); nothing here adds a preventive gate.
- If the tool ever grows a genuine multi-writer scale (an explicit non-goal
  today), this posture is the thing that must change first.
