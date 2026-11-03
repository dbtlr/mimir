---
title: 'ADR 0040: Outbound integrations and host secrets'
description: An outbound integration is an optional adapter in the console server that writes only generic fields through the Engine. A credential the host must read back is stored in the store, encrypted under a key that never enters the store. The T3 Code adapter is the first.
status: accepted
date: 2026-11-03
---

# ADR 0040: Outbound integrations and host secrets

Until now, every Mimir program has only answered requests: the CLI and MCP
call the host, and the host calls nothing. Launching a T3 Code thread from the
console's Start (MMR-622) makes the host call another service for the first
time. ADR 0002 says the core carries no baked-in semantics, and ADR 0035 says
the host is the one owner of the store. This record settles where an outbound
integration lives, what it may write, and how the host keeps the credential it
needs to call out.

## The decision

### An integration is an optional console-server adapter

An outbound integration lives in the console server (`packages/host/src/server`).
The core, the contract, the wire, and the CLI gain no concept from it. The
adapter reaches the store only through Engine verbs, and it writes only the
generic fields those verbs already carry, such as a task's resume handles
(ADR 0026). It never mirrors the other service's catalog, threads, or settings
into the store; each read asks the service again.

Each integration is enabled by one address setting. With the setting unset,
the feature is absent: no console control appears, and existing behavior is
unchanged. A failure of the other service degrades to a state the console
shows (not configured, connect, reconnect, unreachable), never to a broken
page.

Adapter reads and writes are console server functions, off the Engine, like
host administration (ADR 0038). Their queries stay out of the console's
offline snapshot.

### A host secret is encrypted in the store

A credential the host must read back, such as an OAuth access token, is a
**host secret**. Host secrets live in the `host_secrets` table, one row per
name:

| Column       | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `name`       | Primary key; a generic dotted name such as `t3.oauth`      |
| `ciphertext` | The sealed value (below)                                   |
| `created_at` | When the row was first written                             |
| `updated_at` | When the row was last written                              |

The value is sealed with AES-256-GCM under the **secret key**, a 32-byte key
supplied as `MIMIR_SECRET_KEY` or `MIMIR_SECRET_KEY_FILE`, base64 or base64url
encoded. Setting both refuses startup, as with the database URL. The sealed
form is `v1.<nonce>.<ciphertext and tag>`, each part base64url, with a fresh
96-bit nonce on every write. The secret's name is the additional
authenticated data, so a row copied under another name fails to open.

The key never enters the store, the transfer document, or a backup.
`host_secrets` is a host transport table like `device_tokens`: export and
import skip it in both directions, and an import leaves the target host's
secrets intact.

A host without a secret key boots normally; a feature that needs a secret
reports that the key is missing and names the setting. A malformed key is
treated the same way, with the problem named, rather than refusing startup.
A row that fails to open, because the key changed or the row was altered,
reads as absent: the feature asks to connect again.

### The T3 Code adapter

The first integration connects the console server to one T3 Code server.

**Setting.** `MIMIR_T3_URL` is the T3 server's origin: HTTPS, or HTTP on a
loopback host, with no path. On asgard it is
`https://asgard.tail52fcb9.ts.net`, the tailnet address T3 is served on; the
same origin is the OAuth issuer and the origin of every Open in T3 link. A
malformed value makes the feature report the problem; it does not refuse
startup.

**Connect.** T3 serves MCP at `<MIMIR_T3_URL>/mcp` behind standard MCP OAuth.
Connect T3 runs this flow:

1. Discover the authorization server from
   `/.well-known/oauth-protected-resource/mcp`, then its metadata from
   `/.well-known/oauth-authorization-server`.
2. Register a public client dynamically, every time; T3's client ids are
   stateless signed tokens, so nothing about the client is stored.
3. Send the browser to the authorization endpoint with `response_type=code`,
   PKCE S256, a random `state`, `resource=<MIMIR_T3_URL>/mcp`, and the scopes
   `orchestration:read orchestration:operate`.
4. T3's connect screen asks the operator to approve and pick an access level.
   The console's Connect control says to pick full access when launched
   threads should run without approval prompts.
5. T3 redirects to `<console origin>/auth/t3/callback`. The console origin is
   `MIMIR_URL`; without it, only a loopback request origin qualifies, because
   T3 accepts HTTPS or loopback redirects only.
6. The callback checks `state` against a pending authorization held in host
   memory for 10 minutes, checks `iss` against the issuer, and exchanges the
   code with the PKCE verifier. It stores the access token, its expiry, and
   the issuer as the host secret `t3.oauth`, then redirects to `/devices`.

There is no refresh grant: a token lasts 30 days. An expired token, or a
`401` from T3, reads as disconnected and offers Reconnect T3, which runs the
same flow and replaces the secret.

**Client.** The adapter speaks streamable HTTP JSON-RPC directly, without an
MCP SDK: `initialize`, then `notifications/initialized`, then `tools/call`,
carrying `Mcp-Session-Id` when T3 returns one and accepting either a JSON or a
single-event SSE reply. Every request has a timeout.

**Catalog.** A read-only server function returns, for one Mimir project, the
T3 systems it can launch onto. It reads `t3_environment_read` for the
configured server and `t3_environment_links` for its linked peers, then, for
each reachable system, `t3_project_list` and `orchestrator_capabilities` with
that `environmentId`. A system is listed only when it has a T3 project whose
`repositoryIdentity.canonicalKey` equals the Mimir project's normalized
`remote` (ADR 0036). Each system carries:

- its `environmentId`, label, and the matching T3 project's id, title, and
  `defaultModelSelection`;
- its server's `defaultThreadEnvMode`;
- its enabled providers (those with no `constraints`), each with its models
  and their options;
- the runtime modes a launch may use: the provider's `runtimeModes`, or all
  four when T3 lists none, narrowed to those no broader than the caller's
  ceiling. The ceiling is the `runtimeMode` that `orchestrator_capabilities`
  reports for this token, ordered `approval-required`, `auto-accept-edits`,
  `auto`, `full-access`.

A token approved read-only has no `orchestration:operate` scope; the catalog
reports it so the console can ask for Reconnect with a launching access level.

The result is a tagged state:

| State          | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `unconfigured` | `MIMIR_T3_URL` is unset; the feature is absent                       |
| `misconfigured`| A setting is malformed, or the secret key is missing; names which    |
| `disconnected` | No token, an expired token, a token T3 rejected, or a read-only one  |
| `unreachable`  | T3 did not answer, or answered with something other than MCP        |
| `connected`    | The systems above, with the token's expiry and access level          |

The Devices page reads a sibling status function with the same states and no
project, and holds the Connect and Reconnect controls.

## Why

**The console server is the only place an adapter can live without teaching
the core.** The Engine is the one contract every transport shares; putting T3
behind it would make every client speak T3. The console server already holds
host-only concerns (device pairing, ADR 0038) beside the Engine, and the
generic resume handles already describe a run in another tool. The core stays
as general as ADR 0002 asks.

**Re-reading instead of mirroring keeps the adapter thin.** T3 0.1.6 writes its
MCP tools for agents, not as a stable API. A mirror would have to track T3's
model of systems and providers; re-reading per request maps a handful of
fields and nothing more, so a T3 change costs a small adapter edit.

**The store is where host state already lives.** On asgard the host runs on
Postgres with no persistent data directory, and every deploy creates a new
container. A token in the data directory would vanish on each upgrade. Device
tokens already live in the store (ADR 0038). A device token is stored hashed
because the host only checks it; an OAuth token must be sent again, so it is
stored encrypted, and the key stays in deployment secrets so that a database
dump or backup holds only ciphertext.

**Binding the name into the seal** stops a stored row from being moved to
another name and opened there, at no cost.

**Degrading on a bad setting** follows the rule that a bad non-core setting
warns and falls back: the T3 feature is optional, so a typo in its address or
key should leave the board working.

## Considered and rejected

- **A token in the data directory.** The shaping spec's first choice. Rejected
  for asgard's stateless container; it would need a persistent mount for one
  file and force a Reconnect after every deploy until the mount exists.
- **A plaintext token in the store.** Every backup would then hold a live
  credential with write scopes on T3.
- **A long-lived token in configuration.** T3 has no screen for issuing one,
  and its tokens expire after 30 days, so renewing would mean redeploying.
- **Calling T3 from the browser.** T3 allows cross-origin requests, but the
  token would then live on every device, and a phone would have to reach T3
  rather than only Mimir.
- **An MCP SDK.** The adapter needs four calls over one transport; an SDK adds
  a dependency and a session model larger than the use.
- **A list of T3 addresses.** One Connect and one token per server. T3's
  linked environments already list and forward to peers, so Mimir keeps one
  address.

## Consequences

- Migration 0012 adds `host_secrets`; the schema moves to version 12. Rolling
  the host image back past it needs a database restore, as with any migration.
- Deployments that use the T3 feature set `MIMIR_T3_URL` and a secret key; on
  asgard the key comes from the deployment's secret store.
- Rotating the secret key makes every host secret unreadable; each feature
  asks to connect again. No re-encryption step exists.
- The console stays unauthenticated on a single-user tailnet (ADR 0035), so
  any client that can reach it can start Connect T3. The token itself never
  leaves the console server.
- A later integration follows the same shape: an address setting, an adapter
  in the console server, host secrets for its credentials, and generic writes.
