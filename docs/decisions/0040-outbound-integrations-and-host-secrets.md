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
The contract, the wire, and the CLI gain nothing from it, and the core gains
only the generic host-secret store below, with no concept of any integration.
The adapter reaches work state only through Engine verbs, and credentials only
through the host-secret store. It writes only the generic fields those verbs
already carry, such as a task's resume handles (ADR 0026). It never mirrors the
other service's catalog, threads, or settings into the store; each read asks
the service again.

Each integration is enabled by one address setting. With the setting unset,
the feature is absent: no console control appears, and existing behavior is
unchanged. A failure of the other service degrades to a state the console
shows (not configured, connect, reconnect, unreachable), never to a broken
page.

Adapter reads and writes are console server functions, off the Engine, like
host administration (ADR 0038). Their queries stay out of the console's
offline snapshot. An adapter calls a fixed list of the other service's
operations with arguments the server builds; it never forwards an operation
name or raw arguments from the browser.

Adapter failures become tagged states before they reach the host's fault
boundary. Logs name the endpoint and the HTTP status, never a response body,
an authorization code, a PKCE verifier, a token, or key bytes, and a
configuration problem names the setting, never its value.

### A host secret is encrypted in the store

A credential the host must read back, such as an OAuth access token, is a
**host secret**. Host secrets live in the `host_secrets` table, one row per
name, managed by a host-only core module beside the device-token store
(ADR 0038):

| Column       | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `name`       | Primary key; a generic dotted name such as `t3.oauth`      |
| `ciphertext` | The sealed value (below)                                   |
| `created_at` | When the row was first written                             |
| `updated_at` | When the row was last written                              |

The value is sealed with AES-256-GCM under the **secret key**, 32 bytes
supplied as `MIMIR_SECRET_KEY` or `MIMIR_SECRET_KEY_FILE` (preferred, because
container inspection shows environment values). Setting both refuses startup,
as with the database URL. The key is base64 or base64url text, decoded
strictly: after trimming surrounding whitespace it must decode to exactly 32
bytes and re-encode to the same text in its alphabet.

The sealed form is `v1.<nonce>.<ciphertext and tag>`, each part base64url,
with a fresh random 96-bit nonce on every write. The additional authenticated
data is `mimir.host_secret.v1`, a zero byte, and the secret's name, so a row
copied under another name, or read as another version, fails to open.

The key never enters the store or the transfer document. `host_secrets` is a
host transport table like `device_tokens`: export and import skip it in both
directions, and an import leaves the target host's secrets intact. A database
dump holds only ciphertext, as long as the key's own secret store is kept out
of the same backup set.

A host without a usable secret key boots and logs a warning that names the
setting and the problem (missing, or not 32 bytes; setting both still
refuses startup). A feature that needs a secret reports the same problem, refuses to
start a connection before sending the browser anywhere, and writes nothing to
`host_secrets`. A row that fails to open reads as absent, so the feature asks
to connect again, and the host logs that the row failed authentication (the
key changed or the row was altered), without its contents.

### The T3 Code adapter

The first integration connects the console server to one T3 Code server. A
**system** below is one T3 environment: a machine's T3 server, named by its
`environmentId` and label, reached directly or through T3's linked
environments.

**Settings.** `MIMIR_T3_URL` is the T3 server's origin: HTTPS, or HTTP on a
loopback host, with no path. It must be the origin T3 itself reports as its
OAuth issuer, which is the origin it is reached on; on asgard it is
`https://asgard.tail52fcb9.ts.net`. The same origin is the origin of every
Open in T3 link.

The feature also requires Host filtering: `MIMIR_HOSTS` must be set (an empty
value allows loopback names only). Without it, a page on another site could
rebind its own name to the console's address and drive the console's server
functions as a same-origin page; with the T3 feature that reaches agent
threads, not only the store. A malformed `MIMIR_T3_URL`, an unset
`MIMIR_HOSTS`, or no usable secret key makes the feature read
`misconfigured`, naming the setting; none of them refuses startup.

**Connect.** T3 serves MCP at `<MIMIR_T3_URL>/mcp` behind standard MCP OAuth.
Connect T3 is a console server function (a POST, under Start's CSRF check)
that returns the authorization URL; the flow is:

1. Read `/.well-known/oauth-protected-resource/mcp`. Its `resource` must be
   `<MIMIR_T3_URL>/mcp` and its `authorization_servers` exactly
   `[MIMIR_T3_URL]`. Read `/.well-known/oauth-authorization-server`; its
   `issuer` must equal `MIMIR_T3_URL` (RFC 8414 §3.3), and its authorization,
   token, and registration endpoints must share that origin. Anything else
   reads `unreachable`.
2. Register a public client dynamically, every time; T3's client ids are
   stateless signed tokens, so nothing about the client is stored.
3. Hold a pending authorization in host memory: a random `state`, the PKCE
   verifier, the client id, and the redirect URI. It lives 10 minutes, is
   consumed by its first callback, and at most 16 are held; a new one evicts
   the oldest.
4. Send the browser to the authorization endpoint with `response_type=code`,
   the PKCE S256 challenge, the `state`, `resource=<MIMIR_T3_URL>/mcp`, and
   the scopes `orchestration:read orchestration:operate`. T3's connect screen
   asks the operator to approve and pick an access level; the console's
   Connect control says to pick full access when launched threads should run
   without approval prompts.
5. T3 redirects to `<console origin>/auth/t3/callback`. The console origin is
   `MIMIR_URL`; without it, only a loopback request origin qualifies, because
   T3 accepts HTTPS or loopback redirects only.
6. The callback consumes the pending authorization named by `state`, requires
   `iss` to equal `MIMIR_T3_URL`, and exchanges the code with the verifier. It
   seals the access token, its expiry, and the issuer as the host secret
   `t3.oauth`, then redirects to `/devices`. A refused or failed callback also
   redirects to `/devices`, with a reason the page shows and no secret write.

The callback is a host route like the pairing routes (ADR 0038): inside the
host guard, outside the version window and the bearer check. It is a `GET`, so
`state` is its protection.

There is no refresh grant: a token lasts 30 days. Before any call, the adapter
compares the sealed issuer with `MIMIR_T3_URL`; on a mismatch it sends no
token and reads `disconnected`. An expired token, or a `401` from T3, also
reads `disconnected` and offers Reconnect T3, which runs the same flow and
replaces the secret.

**Client.** The adapter speaks streamable HTTP JSON-RPC directly, without an
MCP SDK: `initialize`, then `notifications/initialized`, then `tools/call`,
carrying `Mcp-Session-Id` when T3 returns one and accepting either a JSON or a
single-event SSE reply. Every request has a timeout, and no adapter request
follows a redirect. The tools it calls are `t3_environment_read`,
`t3_environment_links`, `t3_project_list`, and `orchestrator_capabilities`;
MMR-625 adds `t3_thread_launch`.

**Catalog.** A read-only server function returns, for one Mimir project, the
systems it can launch onto. It reads `t3_environment_read` for the configured
server and `t3_environment_links` for its linked peers, then, for each system,
every page of `t3_project_list` and `orchestrator_capabilities` with that
`environmentId`. A T3 project matches when
`tryNormalizeRemote(repositoryIdentity.canonicalKey)` equals the Mimir
project's stored `remote` (ADR 0036). A system is listed when it has at least
one matching project, or when it could not be read (below). Each listed system
carries:

- its `environmentId`, label, and `status`: `reachable`, or `unreachable` when
  T3 reports the link unreachable or one of its reads failed; an unreachable
  system carries nothing else;
- every matching T3 project, each with its `id`, `title`, and
  `defaultModelSelection` (`instanceId`, `model`, or null);
- its server's `defaultThreadEnvMode`;
- its enabled providers (those with no `constraints`), each with its
  `providerInstanceId` and `displayName`, and its models, each with `id`,
  `label`, and `options` (each option's `id`, `values`, and `default`);
- the runtime modes a launch may use, per provider: the provider's
  `runtimeModes`, or all four when T3 lists none, narrowed to those no broader
  than the ceiling. The ceiling is the `runtimeMode` that
  `orchestrator_capabilities` reports for this caller on that system, ordered
  `approval-required`, `auto-accept-edits`, `auto`, `full-access`.

A Mimir project with no `remote` returns `connected` with no systems and
`noRemote: true`.

The result is a tagged state:

| State           | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `unconfigured`  | `MIMIR_T3_URL` is unset; the feature is absent                             |
| `misconfigured` | A required setting is malformed or missing; names which                    |
| `disconnected`  | `reason`: `none`, `expired`, `rejected` (a 401 or issuer mismatch), or `read_only` |
| `unreachable`   | T3 did not answer, or its metadata or replies failed the checks above      |
| `connected`     | The systems above, with the token's expiry                                 |

A token approved read-only lacks the `orchestration:operate` scope; it reads
`disconnected` with reason `read_only`, so the console asks for Reconnect with
a launching access level.

The Devices page reads a sibling status function with the same states and no
project, and holds the Connect and Reconnect controls. Its `connected` state
carries the configured server's label and the token's expiry.

**Writes.** The launch (MMR-625) queues the task with `harness=t3`,
`session=<threadId>`, matching what `mimir start` records inside a T3 thread
(MMR-623), and `host=<environmentId>`. The host handle is the environment id,
not the label, because the Open in T3 link is built as
`<MIMIR_T3_URL>/<environmentId>/<threadId>` and a label can change.

## Why

**The console server is the only place an adapter can live without teaching
the core.** The Engine is the one contract every transport shares; putting T3
behind it would make every client speak T3. The console server already holds
host-only concerns (device pairing, ADR 0038) beside the Engine, and the
generic resume handles already describe a run in another tool. The core stays
as general as ADR 0002 asks: it learns to keep an encrypted value by name, not
what the value is for.

**Re-reading instead of mirroring keeps the adapter thin.** T3 0.1.6 writes its
MCP tools for agents, not as a stable API. A mirror would have to track T3's
model of systems and providers; re-reading per request maps the fields listed
above and nothing more, so a T3 change costs a small adapter edit.

**The store is where host state already lives.** On asgard the host runs on
Postgres with no persistent data directory, and every deploy creates a new
container. A token in the data directory would vanish on each upgrade. Device
tokens already live in the store (ADR 0038). A device token is stored hashed
because the host only checks it; an OAuth token must be sent again, so it is
stored encrypted, and the key stays in deployment secrets.

**Pinning the issuer to the configured address** makes discovery a check, not
a lookup: a misrouted or hostile metadata reply cannot point the host's
requests, a live code, or its verifier at another server.

**Degrading on a bad optional setting** keeps the board working when the
optional feature is misconfigured, and the feature fails closed: without a
usable key it never starts a connection. ADR 0035's 2026-11-03 refinement
records the rule for host settings.

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
- **An MCP SDK.** The adapter needs a few calls over one transport; an SDK
  adds a dependency and a session model larger than the use.
- **A list of T3 addresses.** One Connect and one token per server. T3's
  linked environments already list and forward to peers, so Mimir keeps one
  address.
- **The system's label as the `host` handle.** Readable, but the Open in T3
  link needs the environment id, and a label can change.

## Consequences

- Migration 0012 adds `host_secrets`; the schema moves to version 12. Rolling
  the host image back past it needs a database restore, as with any migration.
- Deployments that use the T3 feature set `MIMIR_T3_URL`, `MIMIR_HOSTS`, and a
  secret key; on asgard the key comes from the deployment's secret store.
- Rotating the secret key makes every host secret unreadable; each feature
  asks to connect again. No re-encryption step exists.
- The console stays unauthenticated on a single-user tailnet (ADR 0035), so a
  client that can reach it can use the stored T3 token through the console:
  with a full-access token, that means starting agent threads on every linked
  T3 system. The token itself never leaves the console server, and Host
  filtering keeps other websites from reaching it through the browser.
- A later integration follows the same shape: an address setting, an adapter
  in the console server, host secrets for its credentials, and generic writes.
