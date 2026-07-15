---
title: 'ADR 0018: Vault access is Norn-only'
status: accepted
date: 2026-07-06
---

# ADR 0018: Vault access is Norn-only

Elevates ADR 0016's founding invariant to a standalone decision with an
escalation rule. ADR 0016 reduced Mimir to "a business-logic + derivation
layer that talks to Norn and never touches files directly" — but carried the
invariant as a passing sentence, and the Phase-3 write path showed a passing
sentence erodes: the node writer acquired a direct `mkdirSync` (pre-creating
each create's parent directory) because the MCP `vault.apply_plan` tool
hardcodes `parents: false`, while the CLI and the sibling `vault.new` /
`vault.move` tools expose the flag.

**Decision.** Mimir never reads or writes vault documents through the
filesystem. Every read and write of work-state content goes through the Norn
MCP surface (one persistent `norn mcp` per vault). When a change appears to
require direct vault filesystem access, that is treated as **evidence of a
missing Norn capability**: the default response is a capability ask filed with
Norn, not a Mimir-side workaround. A direct-access workaround is a last resort
— it ships only together with the filed ask that will retire it, a tracked
removal task, and a dated refinement appended here.

## Why

- **The seam is the correctness boundary.** Norn owns the on-disk contract —
  encoding, frontmatter serialization, section grammar, wikilink collapse,
  CAS/locking, apply atomicity. Any Mimir-side file access re-implements a
  slice of that contract and can drift from it; independent implementations of
  the same boundary semantics are exactly the bug class the section-grammar
  defects (the `append_to_section` boundary collapse) came from.
- **Topology freedom.** API-only access is what allows Norn to move out of
  process or host (its agents-over-network direction). Every direct touch pins
  Mimir to a colocated vault on a shared filesystem.
- **The escalation rule is the generative part.** The `mkdirSync` precedent
  shows the pattern: the "need" for filesystem access was an unexposed Norn
  capability (`ApplyContext.parents` existed end-to-end; only the MCP param was
  missing). Filing the ask yields a one-field Norn change and deletes the
  workaround; keeping the workaround would have normalized the breach.

## Scope: content vs. infrastructure

The invariant governs **vault document content**. Three infrastructure layers
deliberately operate on the vault as a directory/repository, beneath Norn's
remit:

1. **Provisioning** (`vault/converge.ts`) — probing and scaffolding the vault
   directory, writing the identity marker, regenerating the declared `.norn`
   rules, `git init`. This creates the preconditions for Norn to operate;
   `norn init` scaffolds only a generic starter config, not Mimir's rule set.
2. **Version control** (`vault/git.ts`, `vault/snapshot.ts`) — the
   auto-snapshot layer is repository-level and content-agnostic: it never
   parses or produces document content.
3. **The legacy store** — the migration commands hold a raw SQLite handle;
   that is the outgoing SQLite database, not the vault.

Each carve-out is a standing candidate for Norn surfacing: if Norn grows vault
bootstrap or snapshot orchestration, the corresponding carve-out shrinks. A new
filesystem touch that does not fit one of these three categories is a
violation, not a fourth category.

## Known deviation (tracked)

- `norn/writer.ts` pre-creates parent directories (`ensureCreateDirs` /
  `mkdirSync`) so `apply_plan` creates never fail on a missing folder. The
  retiring capability ask is filed with Norn (optional `parents` on MCP
  `vault.apply_plan`, mirroring `vault.new` / `vault.move`); removal is
  tracked as MMR-199.

## Considered and rejected

- **Case-by-case "harmless" filesystem conveniences** — each one re-implements
  a slice of Norn's contract and pins the topology, and the precedent shows
  they arrive invisibly inside larger changes, not as reviewed decisions.
- **A restricted-import ban now** — a lint forbidding `node:fs` across the
  Norn client and core read/write paths is the right structural enforcement,
  but it cannot land while the known deviation stands; it rides MMR-199.

## Consequences

- A capability gap discovered mid-task produces an ask plus (when a workaround
  cannot wait) a blocked removal task — never a silent, permanent workaround.
- Once MMR-199 lands, add the restricted-import lint over the Norn/core
  read-write paths so the invariant is enforced structurally rather than by
  review.
- The infrastructure carve-outs are re-examined whenever Norn's surface grows;
  shrinking one is a refinement here, not a new decision.

## Refinement (2026-07-15, MMR-279): the known deviation closes; the legacy-store carve-out retires

Two of this ADR's own tracked items resolved and are recorded here rather than
left to go stale in place.

- **The known deviation is closed.** MMR-199 landed: `norn/writer.ts` no
  longer pre-creates parent directories — the filed capability ask was
  granted (`vault.apply_plan` gained the `parents` option `vault.new` /
  `vault.move` already exposed), so the writer passes it through Norn instead
  of touching the filesystem directly. The "Known deviation (tracked)" section
  above has no current occupant.
- **Carve-out 3 ("the legacy store") retires.** MMR-234 deleted the SQLite
  store's code entirely, including the raw handle the migration commands
  held — there is no SQLite database left to be a carve-out from. The
  infrastructure carve-out list contracts to two: (1) provisioning
  (`vault/converge.ts`) and (2) version control (`vault/git.ts`,
  `vault/snapshot.ts`). A new filesystem touch that does not fit one of those
  two is a violation, not a candidate third category.
