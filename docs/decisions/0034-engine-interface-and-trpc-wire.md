---
title: 'ADR 0034: The Engine is a plain interface, and the remote wire is tRPC'
description: Define the Engine as a transport-free TypeScript interface typed by contract schemas, implemented locally over a Store and remotely over a tRPC client, with one owner per store.
status: accepted
date: 2026-10-15
---

# ADR 0034: The Engine is a plain interface, and the remote wire is tRPC

Mimir's operations are reachable through three transports: the CLI, MCP, and
the HTTP API with its console. Each reaches the core by calling store-level
functions directly. That works while every client runs next to its store. It
does not work for a CLI on one machine talking to a host on another. A remote
client needs one typed surface to call, and the host needs one place that
answers it.

ADR 0030 lets many installs share one Postgres database but keeps every client
embedded. This record defines the surface a client calls, so a CLI can run
against a local store or a remote host through the same interface.

## The decision

1. **The Engine is a plain-TypeScript interface.** It has one method per
   operation. Its inputs and outputs are typed by zod schemas in
   `@mimir/contract`. The interface has no tRPC, HTTP, or framework
   dependency, so it can be implemented and tested without a transport.
2. **`LocalEngine` is core over a `Store`.** It is the only implementation that
   touches a store. It runs in the CLI for a local SQLite install and inside a
   host for a shared one.
3. **The host's tRPC router is a thin adapter.** It has one procedure per
   Engine method and no logic of its own beyond transport concerns. Each
   procedure parses its input with the contract schema and calls the
   `LocalEngine`.
4. **`RemoteEngine` implements the Engine over the tRPC client.** Router types
   are derived from the Engine interface, never written by hand, so a method
   added to the Engine without a matching procedure, or a procedure whose
   shape drifts, is a compile error.
5. **Domain checks live in the Engine; transport checks live in tRPC
   middleware.** The Engine owns validation, refusals, and every rule a
   `LocalEngine` caller would also hit. Middleware owns the token check, the
   version gate, and the pairing rate limit. A rule that applies to a local
   call belongs in the Engine, so both implementations enforce it.
6. **Console views are Engine methods under `console.*`.** They are exposed
   over the wire for the console. They are kept off the CLI and MCP surface:
   neither transport registers a command or tool for them.
7. **No transport imports core store functions.** The CLI, MCP, HTTP, and
   tRPC layers call the Engine. Only `LocalEngine` calls core, and only core
   calls the store.
8. **Each store has one owner.** The owner is the CLI's local SQLite or one
   host, never both. A client that reaches a host through `RemoteEngine` does
   not also open that store.

## Why

- **A plain interface keeps the domain testable and the wire replaceable.**
  The Engine's behavior is exercised without a server. The wire library can
  change without rewriting the domain, because only the adapter and
  `RemoteEngine` know about it.
- **Deriving router types makes drift a build failure.** Two hand-kept copies
  of the surface, one in the Engine and one in the router, diverge silently.
  With one source, the compiler finds the gap.
- **Splitting domain from transport checks gives both engines the same
  rules.** A local CLI call and a remote one reach the same validation. Token,
  version, and rate-limit concerns exist only where there is a network.
- **One owner per store keeps coordination inside one boundary.** SQLite's
  WAL and `BEGIN IMMEDIATE` locking (ADR 0032) serialize writers only when
  every process shares one machine's filesystem, and a container or VM
  boundary breaks that. A direct client writing a board that a host also owns
  would bypass the host's token check and version gate.

## Considered and rejected

- **The CLI over the existing `/api`.** The CLI renders core view types.
  `/api` returns untyped snake_case resource envelopes (ADR 0012). Counted
  against the code, `next`, `status`, and `triage` have no route. `tree` is
  routed only for projects, and `tag` and `untag` only for nodes. `triage` is
  a board reconciliation that writes annotations, not a read. This corrects
  ADR 0030's statement that every other work verb has a route. The routes
  cover the uniform lifecycle verbs, which the registry generates (ADR 0025),
  and most of the rest, but the count is not the deciding point. Re-plumbing
  every verb's rendering from envelopes back to view types would build the
  typed surface this record defines, with the weaker envelope as its base. ADR 0030 rejected
  a remote CLI over `/api` for the same reason.
- **The tRPC router as the Engine.** Making procedures the interface ties the
  domain to tRPC, so a local CLI would run an in-process tRPC caller to reach
  its own store, and tests would need the library. It also leaves no
  transport-free type to derive the router from.

## Consequences

- Amends [ADR 0025](0025-descriptor-driven-registration.md) (dated refinement
  there): the descriptors that drive CLI, MCP, and HTTP registration
  re-derive from the Engine interface rather than from their own tables. The
  current tables govern until the implementing phase lands.
- ADR 0010 (single binary, and the MMR-15 contract-package rule), ADR 0012
  (resource envelope and network-mode guards), ADR 0013 (embedded SPA), ADR
  0023 (the 1.0 client/host topology), ADR 0030 (direct Postgres bridge), and
  ADR 0032 (CLI and `mimir serve` sharing a local SQLite store) are expected
  to change as the Engine replaces the direct-call transports. Each is
  amended by the phase that changes it, not by this record. ADR 0030's
  shared-Postgres embedded mode and ADR 0032's CLI-plus-serve sharing stay in
  force until the phases that retire them; Decision 8 takes effect with them.
- `@mimir/contract` gains a zod runtime dependency and the Engine's input and
  output schemas, and console view types move there from the HTTP layer. This
  reverses ADR 0010's MMR-15 rule ("no zod, no route map, no client SDK") for
  that package. It takes effect with the phase that adds the Engine schemas,
  which also updates the package description.

## Refinement (2026-10-15 — the first two methods)

`getNode` and `done` are the first Engine methods. Both return the node
projection with `Date` timestamps, including timestamps nested in requested
facets. Existing intent DTOs remain string-valued, preserving current CLI,
MCP, and HTTP output. `getNode` retains its existing facet defaults; `done`
returns the existing write-echo facet set over the completed row.

The tRPC adapter and `RemoteEngine` live in `@mimir/wire`, under separate
server and client entries. Superjson encodes values in both directions so
dates and explicit `undefined` survive without a second set of wire DTOs.
The procedure table's input and output types derive from the Engine, with
compile-time assertions covering the inferred router surface.

`MimirError` lives in the contract package and is re-exported by core. The
adapter carries its code, message, and optional hint; `RemoteEngine`
reconstructs the same class. Transport failures remain transport errors.
Existing transports are migrated in later tasks; this increment does not
change their routing or store ownership.

## Refinement (2026-10-17 — the read methods and project-scoped reads)

Every CLI and MCP read is an Engine method: `next`, `list`, `projects`,
`getNode`, `getArtifact`, `getSeed`, `status`, `tree`, `overview`,
`artifacts`, `search`, `seeds`, `scratchList`, and `scratchGet`. Inputs are
the structured options core already takes. Field filters, date filters, and
verdicts are objects, and the caller's time zone is a field. Parsing flag text
and routing an id by its grammar stay in the client. One read gets one method
per record kind, so `get` is three methods with three output types.

**Board reads name their project.** `next`, `list`, `overview`, `artifacts`,
`search`, `seeds`, and `scratchList` require a project in their input schema.
The project must be a bare key, so a missing project or a literal such as
`all` is a validation refusal, not a scan of every board. Reads by
id need no scope, because the id names its project. `search` returns text
matches from its project only. A full id still finds a record on any board,
along with that record's links, because the query names the project. The
`seeds` requester filter applies within the one board read. `projects` is the only
read that spans projects. A client resolves its own binding into the project
it sends and refuses before calling when it has none. All-project reads gave
wrong answers when a caller forgot its scope, and their cost grows with every
project on the store. The current CLI's `-s all` remains until the Loom CLI
replaces it, and the Loom CLI does not carry it forward.

Tag-scoped rollups (ADR 0005) therefore run within one project. A grouping
that spans boards is read as `projects` filtered by its tag, followed by one
read per project. The console's composite views (`console.*`) settle their own
scope when they become Engine methods.

Rules that both transports duplicated move into the Engine: `overview`
requires a project, and `scratchList` applies the shared row order (a staged
freeze first, then newest first). The Scratchpad reads treat an unknown or
archived project as absent (ADR 0015), as `overview` does.
