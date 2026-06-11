---
title: "ADR 0012: The HTTP API is a true resource envelope; boundary concerns live at the proxy"
status: accepted
date: 2026-06-11
---

# ADR 0012: The HTTP API is a true resource envelope; boundary concerns live at the proxy

What `mimir serve` (Phase 4) actually is, and where the operational boundary sits. Route-level detail lives on `MMR-14`'s annotations; this records the shape decisions.

## The decision

1. **A genuine second envelope, not a third rendering.** The HTTP API is conventional, extensible, resource-shaped REST over the core — _not_ the intent envelope (`next`/`get`/`list`/verbs) re-rendered over HTTP. The driver is the job: a **cross-project operator console** the operator crafts and extends — see everything agents have in flight across all projects, and intervene. The intent envelope is per-scope, agent-curated, and tasks-only in places; the console needs raw, complete, cross-project reads and room to grow.

2. **New capabilities land in core, surfaced by every transport.** The console legitimately demands selections the core doesn't expose yet (nested project tree, cross-project node selection; later artifact retitle/annotation edit → `MMR-40`). They are core capabilities that surface on CLI and API together — a capability never originates in a transport.

3. **Writes stay verb-shaped.** Mutations map to action sub-routes (`POST /api/nodes/:id/start`, `/reorder {before|after}`, …); `PATCH /api/nodes/:id` carries exactly the dumb `update` verb (title/priority/size) and will never accept lifecycle, hold, or rank. No second mutation path around the invariants. Every write echoes the full updated record. Rank stays invisible per ADR 0007 — array order is the contract; reordering is the verb.

4. **Collections are envelope objects** — `{"items": [...]}`, never bare arrays — so cursor/pagination metadata can arrive later as a non-breaking sibling key. Pagination itself is deferred until a real dataset hurts.

5. **Levels never appear in URL structure.** One flat node collection with `?type=` filters; initiative/phase/task stay filter _values_, not resources — keeping the door open for configurable hierarchies. (The external entity name is a placeholder — "node" is tree-internal, "work item" rejected as on-the-nose; rename task pending a better name.)

6. **The binary stays inside the boundary; the proxy _is_ the boundary.** `mimir serve` binds `127.0.0.1` (hard-coded, no `--host`), speaks plain HTTP, runs foreground. TLS, hostname (`mimir.valhalla.local`), and any exposure control belong to the colocated Caddy; staying-up belongs to launchd. **Auth is an open question, deliberately** — Caddy-level control is a candidate, not the decision; nothing in this ADR's rationale may harden into "no auth ever."

## Why

- **The job, not the symmetry, picks the shape.** A third rendering would have been maximally consistent with the CLI/MCP pair, but the console's needs (raw rows, client-side shaping, extension surface) are exactly what the intent envelope was designed to _limit_. Spec §9's "don't point the UI at the agent's interface" survives contact with the build.
- **Verb-shaped writes are non-negotiable doctrine** (ADR 0003's invariants live in the verbs); the REST-conventional spelling of that is action sub-routes — the dumb-verb↔dumb-method symmetry (`update` ↔ `PATCH`) keeps the mapping honest.
- **Boundary-at-proxy keeps Mimir boring.** Building TLS/auth/daemonization into the binary duplicates jobs Caddy and launchd already do better, and single-operator local-first means loopback-plus-proxy covers every actual access path today.

## Considered and rejected

- **Third rendering of the intent envelope** — argued seriously (it's lighter and keeps three surfaces 1:1); rejected because the console job needs capabilities and rawness the intent envelope deliberately withholds.
- **Hono** — the deferral-era router argument dissolved (Bun ≥1.2.3 native routes); remaining buys fail the "name the condition that earned the mechanism" test. Native `Bun.serve`; rationale on `MMR-13`.
- **Typed per-level collections** (`/tasks`, `/phases`, …) — cosmetic 4× routes over one node table; bakes the level taxonomy into the contract.
- **CRUD-ish PATCH for lifecycle/rank** (spec §8's `PATCH /tasks/:id/rank`) — a second mutation path around the verbs.
- **Pagination, websockets, `/v1`, configurable bind — now** — each deferred with its re-entry condition named (slow query; UI outgrows polling `/transitions?since=`; stabilization; Docker/remote-proxy).

## Consequences

- `MMR-14` holds the groomed route-level contract on its annotations and is the build task.
- Glossary **Resource envelope** entry updated (no longer "paginated"; envelope-object rule added).
- Design-spec §8 drift: "paginated" and `PATCH /tasks/:id/rank` are superseded by this ADR.
- The auth question stays open and must be revisited before any non-localhost exposure beyond the colocated proxy.
