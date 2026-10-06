---
title: 'ADR 0012: The HTTP API is a true resource envelope; boundary concerns live at the proxy'
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

6. **The binary stays inside the boundary; the proxy _is_ the boundary.** `mimir serve` binds `127.0.0.1` (hard-coded, no `--host`), speaks plain HTTP, runs foreground. TLS, hostname (`mimir.valhalla.local`), and any exposure control belong to the colocated Caddy; staying-up belongs to launchd. **Auth is an open question, deliberately** — Caddy-level control is a candidate, not the decision; nothing in this ADR's rationale may harden into "no auth ever." Refined in v0.22.1 (MMR-433): `serve` binds `[serve] bind`, loopback by default, the proxy is optional hardening, and auth stays outside the binary; see the refinement below.

## Why

- **The job, not the symmetry, picks the shape.** A third rendering would have been maximally consistent with the CLI/MCP pair, but the console's needs (raw rows, client-side shaping, extension surface) are exactly what the intent envelope was designed to _limit_. Spec §9's "don't point the UI at the agent's interface" survives contact with the build.
- **Verb-shaped writes are non-negotiable doctrine** (ADR 0003's invariants live in the verbs); the REST-conventional spelling of that is action sub-routes — the dumb-verb↔dumb-method symmetry (`update` ↔ `PATCH`) keeps the mapping honest.
- **Boundary-at-proxy keeps Mimir boring.** Building TLS/auth/daemonization into the binary duplicates jobs Caddy and launchd already do better, and single-operator local-first means loopback-plus-proxy covers every actual access path today. Refined in v0.22.1: the binary may also listen on a network address by operator choice; see the refinement below.

## Considered and rejected

- **Third rendering of the intent envelope** — argued seriously (it's lighter and keeps three surfaces 1:1); rejected because the console job needs capabilities and rawness the intent envelope deliberately withholds.
- **Hono** — the deferral-era router argument dissolved (Bun ≥1.2.3 native routes); remaining buys fail the "name the condition that earned the mechanism" test. Native `Bun.serve`; rationale on `MMR-13`.
- **Typed per-level collections** (`/tasks`, `/phases`, …) — cosmetic 4× routes over one node table; bakes the level taxonomy into the contract.
- **CRUD-ish PATCH for lifecycle/rank** (spec §8's `PATCH /tasks/:id/rank`) — a second mutation path around the verbs.
- **Pagination, websockets, `/v1`, configurable bind — now** — each deferred with its re-entry condition named (slow query; UI outgrows polling `/transitions?since=`; stabilization; Docker/remote-proxy). Configurable bind landed in v0.22.1 (MMR-433); see the refinement below.

## Consequences

- `MMR-14` holds the groomed route-level contract on its annotations and is the build task.
- Glossary **Resource envelope** entry updated (no longer "paginated"; envelope-object rule added).
- Design-spec §8 drift: "paginated" and `PATCH /tasks/:id/rank` are superseded by this ADR.
- The auth question stays open and must be revisited before any non-localhost exposure beyond the colocated proxy. Revisited in v0.22.1: see the refinement below.

## Refinement (2026-10-06, v0.22.1, MMR-432 / MMR-433): serve may bind a network address; the proxy is optional hardening

v0.22.0 kept loopback plus a colocated proxy as the only way to reach the
console from another device, and made the Host allowlist mandatory. Every
install reached by an IP address, a MagicDNS name, or a proxy hostname failed
until its operator listed each name, and a changed address broke it again. §6
is refined around one line: a quick install works, and the tools to harden it
are there for an operator who wants them.

- **The listening address is the operator's choice.** `[serve] bind` takes any
  IP literal and defaults to `127.0.0.1`. A wildcard (`0.0.0.0`, `::`) listens
  on every interface; a specific address, such as a tailnet address, listens
  there only. Loopback stays the default, so neither a fresh install nor an
  upgrade exposes the board to a network. Local health probes target the bound
  address for a specific non-loopback bind, and loopback otherwise.
- **The proxy is optional hardening, not the boundary.** A reverse proxy or
  `tailscale serve` in front adds TLS, the secure context the PWA needs, and
  any authentication. Neither is required to reach the console. `[serve] url`
  names the console's public origin for the addresses Mimir prints; it changes
  nothing about what `serve` accepts on its own.
- **Authentication stays outside the binary.** `serve` speaks plain HTTP and
  authenticates no one. A network bind exposes unauthenticated read and write
  to everyone who can reach the address, and that exposure is the operator's
  choice. Access control belongs to the network (a tailnet) or to a proxy. This
  settles the open question in §6 for the current binary; it does not rule out
  an auth layer later.
- **Hardening that needs configuration is opt-in; hardening that needs none
  stays on.** The Host allowlist against DNS rebinding applies only when
  `[serve] hosts` is set (MMR-432). `hosts = []` answers the loopback names
  only; when `hosts` is set, a specific `bind` address and the host of `url`
  are answered too. The cross-origin write check (ADR 0013, v0.22 refinement)
  is always on: Caddy and `tailscale serve` both keep the browser's `Host`, so
  it needs no configuration in any mode.
- **Four network modes** are documented in the
  [port and proxy guide](../guides/port-and-proxy.md): local only (the
  default), `tailscale serve` (the recommended remote path), direct network
  (`bind`), and a reverse proxy.

Why:

- The Host allowlist covers DNS rebinding from a page the operator visits. That
  threat is real but narrow for a single-operator internal service, and
  requiring a proxy plus a host list to reach the console at all cost more than
  the protection was worth as a default.
- `tailscale serve` is a remote path that needs no Mimir configuration: it
  terminates TLS with a `ts.net` certificate, limits exposure to the tailnet,
  and its proxy sets the outbound `Host` to the inbound one, so console writes
  pass the cross-origin check.

Considered and rejected:

- **Listening on every interface by default** — it would serve the board,
  unauthenticated, to every network a laptop joins.
- **A loopback-or-all switch for `bind`** — binding only the tailnet address
  keeps the board off the LAN, which an enum cannot express.
- **`url` turning on the Host check** — the address an operator hands out is
  not the set of names `serve` accepts. Setting one never silently enables the
  other.

Consequences: without `hosts`, a page whose domain rebinds to the daemon's
address can read and write the board; the guide says when to set it. Invalid
`bind`, `url`, and `hosts` values degrade with a warning rather than stopping
`serve`, as `port` already did.
