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
read per project. The console's composite views (`console.*`) are exempt from
the bare-key rule; the 2026-10-18 refinement settles their scope.

Rules that both transports duplicated move into the Engine: `overview`
requires a project, and `scratchList` applies the shared row order (a staged
freeze first, then newest first). The Scratchpad reads treat an unknown or
archived project as absent (ADR 0015), as `overview` does.

## Refinement (2026-10-18 — the node writes)

Every node write is an Engine method: `create`, `update`, `updateProject`,
`annotate`, `attach`, `depend`, `undepend`, `move`, `reorder`, `groom`, `tag`,
`untag`, and the twelve uniform verbs. Inputs are canonical ids and structured
values. Shorthand, flag text, and ids resolved against a binding stay in the
client. One write gets one method per record kind, so a project's fields have
their own `updateProject`, whose `id` is a bare project key, and `create` is a
union on `type`. The `update` input carries every field core's update
vocabulary has, including `next` (a container's direction) and, on
`updateProject`, `pinned`. A cleared field is `null`, and `upstream` is a seed
id or `null`. The seed and Scratchpad writes are the next refinement.

The uniform verbs are not written out. Their input and output schemas, the
`LocalEngine` methods, the router procedures, and the `RemoteEngine` bindings
are built by iterating the operation facts (ADR 0025), so a verb's input takes
exactly the arguments its fact declares: `reason` when the fact allows one, the
resume handles on `start`, and the choice on `block`. A verb that also acts on
a seed (`park`, `unpark`) answers a seed id with the seed view. Project verbs
take a bare key. `done` is derived this way and keeps its former input and
output.

Every node write answers with the written record, projected with the same
facets as the CLI's write echo (ADR 0003) and `Date` instants. `attach` answers
with the artifact including its content. `tag` and `untag` answer with the ids
and tags, and `untag` also with the count removed. Domain checks that the
transports each repeated, such as a blank annotation or content, an `upstream`
that is not a seed id, and a missing attach target, live in the Engine. Refusals
cross the wire as `MimirError` with the same code, message, and hint. The
archive echo does not list released dependents.

## Refinement (2026-10-18 — Seed and Scratchpad writes)

The Seed and Scratchpad writes are Engine methods. Seeds: `seedCreate`,
`seedPromote`, `seedResolve`, `seedReject`, `seedPark`, `seedUnpark`,
`seedUpdate`, and `triage`. Scratchpads: `scratchCreate`, `scratchUpdate`,
`scratchCheckpoint`, `scratchAgendaAdd`, `scratchAgendaComplete`,
`scratchAgendaSupersede`, `scratchFreeze`, and `scratchDiscard`. All are
mutations.

A write that creates a record (`seedCreate`, `scratchCreate`) and `triage`
take a bare project key, like the board reads. A write on an existing record
takes its id, which names the project.

A Scratchpad write guards against concurrent edits with
`expectedUpdatedAt`. The Engine takes it as a `Date`, the value the previous
Scratchpad output carried, so a client echoes the instant it read rather than
a string. Every Scratchpad write that returns the Scratchpad returns the full
record, as `scratchGet` does. `scratchFreeze` returns the new artifact as an
`artifactDetail`, and `scratchDiscard` returns `{ id, result: 'discarded' }`.
`seedPromote` returns `{ seed, created?, spawnedId }`.

A Scratchpad in an archived project reads as absent to every id-keyed
Scratchpad write, as it does to `scratchGet` (ADR 0015). Seed verbs already
refuse an archived board.

`seedPark` and `seedUnpark` act on seeds only and stay apart from the uniform
`park` and `unpark`, which answer a node or a seed by id. The seed-only
methods give a caller a seed-typed answer without narrowing a union.

## Refinement (2026-10-18 — the console views)

The console's composite views are Engine methods in a `console` namespace:
`console.review`, `console.projectWork`, `console.nodeWork`, and
`console.overview`. They cover the review page, the project and container work
pages, and the project overview. Each is a query, and it returns `Date`
instants like every other read. The CLI and MCP register no command or tool
for them, and a parity test keeps `console.*` off both surfaces.

**The bare-key rule governs the CLI and MCP read surface, not `console.*`.**
A console view takes the scope its page needs. `console.review` spans every
active project and takes no project argument. `console.projectWork` takes a
project key. `console.nodeWork` takes an initiative or phase id.
`console.overview` takes a project key. Core checks each key, so a task id, a
project key sent to the container route, or an unknown project is refused with
the same code and message as the matching `/api` route. A page that places a
shipped window requires the caller's time zone and has no fallback zone (ADR
0029).

**Core assembles each view once.** The HTTP handlers and the Engine call the
same core functions, so the key checks, the time-zone requirement, and the
findings handling cannot drift. Wiring `/api` and the console to the Engine
stays with the later phases.

**Health and the doctor facet stay host concerns, and core never runs
doctor.** `console.review` needs per-project finding counts, and `reviewOf`
already takes them from its caller. The seam is a findings provider, an
optional `findings` function in the options the host gives `LocalEngine`. The
host builds it from its doctor facet. Without a provider the page counts no
findings. A provider that fails counts no findings and logs a warning rather
than failing the page, as the `/api/review` route does. The alternative was an
input on the method. It would let any caller assert finding counts and would
put the doctor facet on the wire, so the host keeps it.

`/api/transitions` is not an Engine method. Nothing calls it, and it is
deleted with `/api`.

## Refinement (2026-10-18 — the console's server functions and its search)

The console reaches the host's Engine through TanStack Start server functions
(ADR 0035), the first ones serving the shell. Each server function is one
Engine method on the host's shared `LocalEngine`. It is named after the
method, validates its input with the method's contract schema, and returns
the Engine's output with `Date` instants. The handlers reach the Engine
through a helper typed as the `Engine` interface, not `LocalEngine`, so a
handler cannot reach a store. A lint boundary keeps the server-function
modules from importing core or the `/api` handler, which makes Decision 7
a check rather than a convention. Query policy stays in the console's data
layer: the facets a read asks for, its cache key, and its polling. Health
stays the host's `/health` route.

**`console.search` is the jump palette's search.** The palette searches every
project and ranks the current one first, which the flat `search` cannot do
under the bare-key rule. `console.search` takes an optional `project` that
ranks that project first and resolves a bare suffix there, and it spans every
project otherwise. A blank query is a validation refusal and an unknown
ranking project is not found, as on `/api/search`. One difference is
deliberate: `/api/search` reads an empty `project` or the literal `all` as no
project, while `console.search` takes no project as no project and refuses
those values as an unknown project, since a structured input has no unset
field to serialize. The flat `search` keeps the CLI and MCP surface, which
stays project-scoped.

The console persists its query cache for offline reads. An Engine read
restored from that snapshot must keep its `Date` instants, so the snapshot
is encoded with superjson, the codec the tRPC wire already uses.

## Refinement (2026-10-18 — the browsers, seeds, artifacts, and record health)

The task, seed, and artifact browsers, the seed and artifact pages, and the
seed writes run on server functions over the flat Engine methods: `list`,
`seeds`, `artifacts`, `getSeed`, `getArtifact`, and the seed writes. The
browsers live under their project (`/p/KEY/…`), so the project-scoped reads
and the bare-key rule fit them, and no `console.*` variant is needed for
them.

**`console.upstreamTasks` is a seed page's outcomes.** A seed's page lists
the tasks that name it as their upstream, and those tasks sit on the
requesting boards, not the seed's own. The flat `list` cannot span boards
under the bare-key rule, and a fan-out over every project from the browser
would cost one request per board. `console.upstreamTasks` takes a seed id and
answers the tasks on any board that name it, live or settled, in the set
projection `/api/nodes` serves. A seed nothing names, or an id that names no
seed, has none, as on `/api/nodes`. Like every `console.*` method it is
registered on neither the CLI nor MCP.

**`console.openTasks` is the dependency picker's lookup.** The picker spans
every project and offers open tasks whose id or title holds the typed text, as
`/api/nodes?type=task&q=` answers it. The palette's `console.search` cannot
stand in: it windows its hits across every record kind before a caller could
drop the non-task and finished ones, so newer records crowd older open tasks
out, and its ID modes answer linked records that do not match the text.
`console.openTasks` filters before it answers, in the set projection
`/api/nodes` serves.

**A seed's lane is classified once, in the contract.** The `/api` wire serves
each seed's lane, and an Engine seed carries the lifecycle and the
ready-to-resolve flag the lane derives from. The classifier moves from core
to the contract, so the CLI, the wire, and the console read one rule and the
Engine output does not grow a derived field.

**Record health is a host read, not an Engine method.** Decision 7 and the
console-views refinement keep doctor with the host. The console reads it
through a server function that calls the host's own doctor facet, as
`/api/doctor` does. The server-function boundary still holds: the one module
that opens the host runtime hands handlers the `Engine` and a narrow
record-health accessor, and nothing else.

## Refinement (2026-10-19 — the archive echo lists what it released)

`archive` answers with the project record plus `released`, the ids of the
out-of-project tasks the archive freed (ADR 0015 Refinement). The Engine
computes them in the same call, after the archive lands, so a composition
root with no store, such as a remote one (ADR 0037), can still name them.
This replaces the node-writes refinement's rule that the archive echo does not
list released dependents. `unarchive` and the other uniform verbs keep the
record alone.

## Refinement (2026-10-19 — artifact edits)

`updateArtifact` is an Engine method beside `updateProject`, following the
one-method-per-record-kind rule. It takes an artifact id (`KEY-aN`) and an
optional `title` and `summary`; a `null` summary clears it, and a blank title is
refused. It answers with the artifact's detail without its content, as
`getArtifact` does by default. An id that names no artifact is not found.

## Refinement (2026-10-20 — the transport checks of Decision 5)

[ADR 0038](0038-device-pairing-and-the-version-window.md) settles the three
transport checks that Decision 5 assigns to middleware. Decision 5's version
gate is a compatibility window: middleware refuses a client older than `MIN_CLIENT` or
newer than the host by minor version. The token check is a bearer device token
on every Engine procedure under `/trpc`, and it runs after the host guard and
the version window. The pairing rate limit guards the redeem endpoint, a host
route outside the Engine and outside the bearer check, like `/health`. Codes
and tokens stay off the Engine.

## Refinement (2026-10-30 — clearing prose is explicit)

The node-writes refinement makes `null` the value that clears a field. For the
two long prose fields, `null` is now the only way to clear. `update` and
`updateProject` refuse a `description` or `next` that is empty or only
whitespace, and `seedUpdate` refuses such a `description`. The refusal is a
`validation` error, and the stored text is unchanged. A `null` clears the
field. As before, clearing a `## Next` that is absent writes nothing, and
clearing one that is present but empty removes it.

Neither field keeps its earlier text, so a blank that clears loses the prose
for good. The blank usually comes from a script whose input file is missing or
empty, not from a person choosing to clear. Refusing blank text in the Engine
covers every client, local or remote. A client that offers a clear exposes it
as its own explicit act:

- The CLI has `--clear-direction` and `--clear-desc`, and MCP has the matching
  `clear-direction` and `clear-desc` inputs. Each is refused wherever its text
  flag is, and passing a clear flag with its text flag is a usage error.
- The console sends `null` when a person saves a direction or description
  editor whose text is empty or only whitespace.

`MIN_CLIENT` does not rise, and the change ships in a minor release (ADR 0038).
A client from before this refinement that sends a blank to clear is refused,
and the text survives; it cannot clear these fields until it is updated.

Every other field keeps its current behavior. Creates keep their current
handling of a blank `description`, because nothing exists yet to lose.
`summary`, `remote`, and the resume handles still treat a blank as a clear;
they are one line long and cheap to rewrite.
Store import is outside the rule: a transfer document restores the prose it
carries, a present-but-empty `## Next` included.
