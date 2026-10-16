---
title: 'ADR 0035: The host is a TanStack Start container'
description: Run the console and Engine transports in one Bun host image, configured through environment variables and responsible for its store migrations.
status: accepted
date: 2026-10-15
---

# ADR 0035: The host is a TanStack Start container

## Context

[ADR 0034](0034-engine-interface-and-trpc-wire.md) defines the Engine and its
local and remote implementations. The host needs a distribution and runtime
boundary that serves the console and remote clients over one store.
[The glossary](../glossary.md) defines host and store owner.

The console already fetches through TanStack Query without route data loaders.
Server rendering adds no needed behavior. The SQLite driver uses `bun:sqlite`,
so the host needs Bun rather than Node. A container gives the host its own
configuration, store authority, and release artifact without extending the
CLI's installation and supervisor machinery.

## The decision

### One app serves the console and Engine transports

The host is a TanStack Start app in SPA mode, running on Bun through Nitro's
`bun` preset. Start prerenders the application shell at build time instead
of using the console's current `index.html`. The shell contains no store data.
TanStack Query continues to fetch data on the client.

Console server functions and the tRPC server route at `/trpc` call one
`LocalEngine` over the host's store. Domain validation and refusals stay in the
Engine, as ADR 0034 requires. Health at `/health` and the backend-provided
doctor facet are host concerns outside the Engine.

The console, including its server functions, stays unauthenticated on a
single-user tailnet. ADR 0034's token check belongs to remote CLI and MCP
access through tRPC when device pairing lands. Console functions do not
require a device token. Host filtering and cross-origin checks still apply
to both surfaces, but neither check authenticates a caller.

The existing `/api` handler is a transitional pass-through inside the host.
It preserves the current console contract until the console moves to server
functions, then leaves with that migration. It is not a second permanent API.

### Environment variables configure the host

The host does not read the CLI's `config.toml`. Its configuration is:

| Variable | Meaning |
| --- | --- |
| `MIMIR_DATABASE_URL` | Select Postgres with the supplied connection URL. |
| `MIMIR_DATABASE_URL_FILE` | Read the Postgres connection URL from a file, such as a mounted Docker secret. |
| `MIMIR_DATA_DIR` | Directory for SQLite when neither database URL variable is set. The image defaults to `/data`. |
| `MIMIR_HOSTS` | Configure ADR 0012's optional Host allowlist. |
| `MIMIR_URL` | Name the public console origin. Setting it does not enable the Host allowlist. |
| `MIMIR_PORT` | Listening port, default `64647`. |

Setting both `MIMIR_DATABASE_URL` and `MIMIR_DATABASE_URL_FILE` refuses
startup and names both variables. Neither value takes precedence. Other
invalid configuration refuses startup and names the offending variable.
Container port publishing controls the externally reachable listening address.
The CLI's `[serve] bind` has no host configuration counterpart.

The Host allowlist and the cross-origin write check run as request middleware
over every host route, including server functions and tRPC. The allowlist
remains opt-in, and the cross-origin write check remains always on. Public
origin configuration does not grant authentication or disable either check.
These preserve the guard semantics of
[ADR 0012](0012-http-api-true-resource-envelope.md) and
[ADR 0013](0013-ui-embedded-spa.md) across the new route surfaces.

### The image owns live-store authority

Only the built host image may open a live Postgres URL through the host entry
point. A host-authority constant set at image build grants that capability.
An environment variable cannot grant it to a development host.

A development host uses an isolated `.dev` SQLite store or a sandbox's
existing authority. Sandbox Postgres access remains limited to the endpoint
that its authority owns. Neither supplying a live URL nor mounting a secret
file grants a development host access to that database.

This refines [ADR 0031](0031-installation-authority-and-disposable-development.md)
for the container. CLI installation receipts continue to govern installed
executables. The image authority is an accidental-access boundary, with the
same limits as receipts, not an OS security boundary against modified code.

### The host migrates before serving

The host migrates its store on startup, for SQLite and Postgres alike. It is
the designated server, so updating the host first applies the release's
migrations before the CLIs are updated. A migration failure prevents serving.
A schema newer than the host supports refuses startup rather than downgrading.

This refines [ADR 0030](0030-postgres-store-backend-shared-store-bridge.md):
the container host may migrate Postgres implicitly on boot. Direct Postgres
CLIs keep the explicit `mimir store upgrade` gate and refuse a newer schema
until updated. The local SQLite CLI retains ADR 0032's migration-on-open
behavior. A remote CLI does not open or migrate the host's store.

### One image version follows the CLI

The host ships as `ghcr.io/dbtlr/mimir-host`, versioned with the CLI from
`packages/bin/package.json`. The container carries the console, the host
routes, and the store runtime. It does not require a CLI installation receipt
or the CLI's service installation commands to run.

## Validation and migration boundary

This accepted record governs the host implementation. It does not claim the
container or its PWA integration is already implemented. MMR-529 must first
prove that `vite-plugin-pwa` precaches Start's prerendered shell and that the
console runs from the container through the transitional `/api` handler. If
that experiment fails, re-shape the stack before configuration, image, and
cutover work continue. The service worker caches the shell, not API data.

Existing CLI and `mimir serve` behavior remains governed by the current ADRs.
In particular, direct Postgres installations retain ADR 0030's bridge, and
local CLI-plus-serve SQLite sharing retains ADR 0032's rules. ADR 0034's one
owner per store takes effect as those paths retire. A container-owned store
is not also opened by a direct client after its cutover.

ADRs 0010, 0012, and 0013 receive dated refinements in the tasks that retire
`serve`, change distribution, and delete `/api`. ADR 0032's sharing boundary
and ADR 0023's topology are reconciled when the ownership cutover lands, as
ADR 0034 requires. Their current rules are not retired by accepting this record.

## Considered and rejected

- **Keep expanding `mimir serve`.** It couples the host's runtime and update
  lifecycle to an installed CLI and its supervisor. A separate image gives
  the designated server its own delivery boundary.
- **Render console routes on the server.** The console already gets its data
  through client queries. SPA mode preserves that model while adding server
  functions and server routes.
- **Use Node for the host.** The existing SQLite driver depends on Bun.
- **Read host configuration from the CLI's installation.** That would couple
  container deployment to receipts and machine directories. Environment
  variables and mounted secret files fit the container boundary.
- **Require a CLI to upgrade the host's Postgres store.** A newly updated
  server would wait for a client before it could serve. Boot migration makes
  the server-first update order sufficient.

## References

- [TanStack Start SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode)
- [Nitro's Bun runtime preset](https://nitro.build/deploy/runtimes/bun)
