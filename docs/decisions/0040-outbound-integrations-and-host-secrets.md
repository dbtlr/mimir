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
as with the database URL. The key is base64 or base64url text, read
strictly: after trimming surrounding whitespace it must be 43 characters of
one alphabet, optionally followed by one `=`, so that it decodes to exactly 32
bytes. An unreadable key file is an unusable key.

The sealed form is `v1.<nonce>.<ciphertext and tag>`, each part base64url,
with a fresh random 96-bit nonce on every write. The additional authenticated
data is `mimir.host_secret.v1`, a zero byte, and the secret's name, so a row
copied under another name, or read as another version, fails to open.

The key never enters the store or the transfer document. `host_secrets` is a
host transport table like `device_tokens`: export and import skip it in both
directions, and an import leaves the target host's secrets intact. A database
dump holds only ciphertext, as long as the key's own secret store is kept out
of the same backup set.

A host without a usable secret key boots normally. When a feature that needs
a secret is enabled, the host logs a warning at startup that names the
setting and the problem (missing, unreadable, or malformed; setting both
still refuses startup), and the feature reports the same problem, refuses to
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
loopback host, with no path. An empty value counts as set and malformed, as an
empty `MIMIR_URL` counts as set. It must be the origin T3 itself reports as its
OAuth issuer, which is the origin it is reached on; on asgard it is
`https://asgard.tail52fcb9.ts.net`.

The feature also requires Host filtering: `MIMIR_HOSTS` must be set (an empty
value allows loopback names only). Without it, a page on another site could
rebind its own name to the console's address and drive the console's server
functions as a same-origin page; with the T3 feature that reaches agent
threads, not only the store.

With `MIMIR_T3_URL` set, the feature reads `misconfigured`, naming the
setting, when `MIMIR_T3_URL` is malformed, `MIMIR_HOSTS` is unset, no usable
secret key exists, or `MIMIR_URL` is an HTTP origin on a non-loopback host
(T3 refuses such a redirect). None of them refuses startup, and the host logs
each at startup.

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
   stateless signed tokens, so nothing about the client is stored. A failed
   registration reads `unreachable`, before the browser is sent anywhere.
3. Hold a pending authorization in host memory: a random `state`, the PKCE
   verifier, the client id, the redirect URI, and the token endpoint step 1
   checked, so the callback exchanges the code without discovering again. It lives 10 minutes, is
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
   T3 accepts HTTPS or loopback redirects only. Connect from any other origin
   without `MIMIR_URL` returns `misconfigured`, naming `MIMIR_URL`.
6. The callback consumes the pending authorization named by `state`, requires
   `iss` to equal `MIMIR_T3_URL`, and exchanges the code with the verifier.
   The granted scope is the token response's `scope`, or the requested scopes
   when it has none (RFC 6749 §5.1). A grant without `orchestration:operate`
   is refused: the token is discarded. Otherwise the callback seals the access
   token, its expiry, and the issuer as the host secret `t3.oauth`, and
   redirects to `/devices?t3=connected`.
7. A refused or failed callback writes no secret and redirects to
   `/devices?t3=<reason>`, one of `denied` (the operator declined),
   `stale` (an unknown, used, or expired `state`), `read_only` (the grant
   cannot launch), `issuer` (an `iss` mismatch), `misconfigured`, or `failed`
   (the code exchange failed, T3 returned another error, or the grant is not
   a Bearer token with a whole-second lifetime of at most ten years). The page words each reason itself and
   never shows text from T3.

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
every page of `t3_project_list`, `orchestrator_capabilities`, and, for a peer,
`t3_environment_read`, each with that `environmentId`. Peers are listed once
per `environmentId`. When `t3_environment_links` is absent (T3 answers that
the tool is not found, because linked environments are off), there are no
peers; any other failure of it reads `unreachable`. A project list that is
still paging after 100 pages counts as a failed read. A T3 project matches when its
`repositoryIdentity.locator.remoteUrl`, normalized with `tryNormalizeRemote`,
equals the Mimir project's stored `remote` (ADR 0036). The remote URL is
normalized rather than T3's `canonicalKey`, because the key is already in a
`host/path` form that Mimir's normalizer does not read, and T3 may fold its
case. A T3 project without a repository identity never matches.

A system is listed when it has at least one matching project, or when it
could not be read (below). Each listed system
carries:

- its `environmentId`, label, and `status`: `reachable`, or `unreachable` when
  T3 reports the link unreachable or one of its reads failed, and whether it
  is the configured server (`configured`); an unreachable system carries
  nothing else;
- every matching T3 project, each with its `id`, `title`, and
  `defaultModelSelection` (`instanceId`, `model`, or null);
- its server's `defaultThreadEnvMode`;
- its enabled providers (those with no `constraints`), each with its
  `providerInstanceId` and `displayName`, and its models, each with `id`,
  `label` (null when T3 gives none), and `options` (each option's `id`,
  `values`, and `default`);
- the runtime modes a launch may use, per provider: the provider's
  `runtimeModes`, or all four when T3 lists none, narrowed to those no broader
  than the ceiling. The ceiling is the `runtimeMode` that
  `orchestrator_capabilities` reports for this caller on that system, ordered
  `approval-required`, `auto-accept-edits`, `auto`, `full-access`.

A Mimir project with no `remote` returns `connected` with no systems and
`noRemote: true`. The catalog always reads `t3_environment_read` first, so
a missing, expired, or rejected token reads `disconnected` for such a
project too.

The result is a tagged state:

| State           | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `unconfigured`  | `MIMIR_T3_URL` is unset; the feature is absent                             |
| `misconfigured` | A required setting is malformed or missing; names which                    |
| `disconnected`  | `reason`: `none`, `expired`, or `rejected` (a 401 or an issuer mismatch)   |
| `unreachable`   | T3 did not answer, or its metadata or replies failed the checks above      |
| `connected`     | The systems above (or `noRemote`), with the token's expiry                 |

The Devices page reads a sibling status function with the same states and no
project, and holds the Connect and Reconnect controls. It reads
`t3_environment_read` to check the token, and its `connected` state carries
the configured server's label and the token's expiry. Because Connect depends
on the request origin when `MIMIR_URL` is unset, the status function also
reads `misconfigured`, naming `MIMIR_URL`, for a non-loopback request in that
case.

**Launch.** Launching a task (MMR-625) is a console server function, a POST
under Start's CSRF check, that creates a thread and then queues the task for
it. Its input names a choice, never a T3 operation:

| Field             | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `task`            | The Mimir task id                                                              |
| `environmentId`   | The system to launch on                                                        |
| `projectId`       | The matching T3 project on that system                                         |
| `model`           | `instanceId`, `model`, and `options`, a list of `{ id, value }`                |
| `runtimeMode`     | One of the four runtime modes                                                  |
| `interactionMode` | `default`, or `plan` to plan before acting                                     |
| `workspace`       | `root` (the project checkout) or `worktree`, with an optional new `branch`     |
| `attempt`         | A random id the browser makes for one launch, 16 to 64 of `[A-Za-z0-9_-]`      |

An **attempt** is one launch of one task with one choice. The browser keeps
its attempt while it retries after `unreachable` or `not_queued`, and makes a
new one only for a new launch or a changed choice. The host remembers each
attempt it has sent to T3 (the task, the checked choice, and the `threadId`
once T3 answers) for 24 hours, at most 256, evicting the oldest, in memory
like the pending authorizations.
Before step 1, a known attempt with another task or choice reads `invalid`,
naming `attempt`. The registry does not survive a host restart: a retry of a
lost reply after one reads `taken`, naming the operator's own thread, which
the console then offers to open, or `not_ready` once the agent has started
the task. One launch per task runs at a time on the host: a second launch of
the same task waits for the first to settle before step 1.

The function runs these steps in order, and each refusal comes before
anything after it:

1. Read the task through the Engine. When this attempt is a known one with
   a `threadId` and the task's main session is that thread, in any open
   lifecycle, the launch already happened: it reads `launched` without
   reaching T3. Otherwise, a task that `queue` accepts (open, unheld, `todo`)
   goes on; any other `queued` task reads `taken`, naming its `harness`,
   `session`, and `host`; and anything else reads `not_ready`. Neither
   refusal reaches T3.
2. Read the chosen system fresh, as the catalog reads one system, and check
   the choice against it. The system must be the configured server or one of
   its listed peers, or the launch reads `invalid`, naming `environmentId`.
   A peer T3 reports unreachable, or a system whose reads fail, reads
   `unreachable`; the disconnected states read as they do for the catalog.
   Then: `projectId` is one of its matching projects; `instanceId` is an
   enabled provider there and `model` one of its models; each option `id`
   appears at most once and is one of the model's options, with a `value`
   from that option's values (an option T3 lists with no values cannot be
   set); `runtimeMode` is one the provider may launch with, so no broader
   than the ceiling; a `branch` comes only with `worktree`. A branch is 1 to
   200 characters of `[A-Za-z0-9._/-]`, does not start with `-`, and is not
   `HEAD`; split on `/`, each component is non-empty, starts with no `.`,
   ends with neither `.` nor `.lock`, and holds no `..`. A
   choice that fails reads `invalid`, naming the field, and nothing is
   launched. Options the input leaves out are left out of the launch, and T3
   applies its own defaults.
3. Call `t3_thread_launch` with the checked choice, the thread title
   `<id> <title>`, the first message `Work <id>.`, and the `clientRequestId`
   `mimir:<task>:<attempt>`. The message carries the id and nothing a task
   writer typed; the agent reads the task from Mimir. T3 answers the same
   thread for the same id, so a retry of an attempt never makes a second
   thread. The launch call's timeout is 60 seconds, because creating a
   worktree can be slow. A launch that T3 answers with a tool error
   (`isError`), or that fails because T3 has no launch tool, reads `refused`,
   without T3's text, because T3 refuses some launches on every try (a branch
   that already exists); the operator launches again as a new attempt, with
   the same choice or a changed one. A missing read tool still reads
   `unreachable`, as in step 2. A reply without a `threadId` reads
   `unreachable`.
4. Queue the task with the writes below. When the task's main session is
   already `<threadId>`, queued or in progress, an earlier try of this
   attempt queued it or the agent in the thread started it first, and the
   launch reads `launched`. A task the agent started first carries no
   `host` unless its start filled one from `T3CODE_ENVIRONMENT_ID` (the
   MMR-627 refinement below); without that variable it gets no Open in T3
   link. That race needs the agent to start before the queue write a few
   milliseconds later, and is accepted.

The answer is a tagged state: the unavailable states above; `not_ready`;
`taken` with the queued `harness`, `session`, and `host`; `refused`; `invalid` with the `field`;
`launched` with `threadId`, `environmentId`, and the system's `label`; or
`not_queued` with the same three and the Engine's refusal message, when the
thread exists but the queue failed. Only `unreachable` and `not_queued` are
worth a retry of the same attempt; a `not_queued` retry whose task another
session has since queued or started reads `taken` or `not_ready` and ends.
A thread whose task ends up `taken` is left in T3 for the operator to close. The
queue does not re-check the project's remote: a remote changed between steps
2 and 4 leaves the task queued for a thread in the old repository, which
`unqueue` undoes.

**Writes.** The launch queues the task with `harness=t3`,
`session=<threadId>`, matching what `mimir start` records inside a T3 thread
(MMR-623), `host=<environmentId>`, and `branch` when the workspace names one.
The host handle is the environment id, not the label, because the Open in T3
link is built from it and a label can change. When the launched agent starts
the task and the started task has no worker, the start keeps `host` and
`branch` (ADR 0026, MMR-625 refinement), so the link survives it. A start
that supplies its own `--host` replaces the stored one, and a start that
leaves the task with a worker clears it; either leaves the task with a different link or none, which
the operator can see and correct with `update`.

**Open in T3.** A task with `harness=t3` and both `host` and `session` set
links to T3's app link, `t3code://threads/<host>/<session>`, each handle
percent-encoded as one path segment; a handle that is empty, `.`, or `..` gets
no link. T3's desktop and mobile apps open that link on the thread, through
any linked system, and the link opens in place because it hands off to the
app. The web UI's `<MIMIR_T3_URL>/<host>/<session>` is not used: it needs a
browser paired with T3's web UI, and operators work in the app. T3's own
`link` is not used either: its `t3-thread://` form opens only inside T3's
chat. The console reads the configured origin from a server function that
answers `MIMIR_T3_URL` when the feature is configured and `null` otherwise,
and shows the link only with one; it reads no secret and calls nothing. A
thread an agent started by hand records no `host` (MMR-623) and gets no link.

**Defaults.** The browser picks the launch's defaults from the catalog, and
the server keeps none (shaping principle 5). The system is the configured
server when it has a matching project, or else the only reachable system that
does. The project is the system's one matching T3 project; with several,
there is no default project. The model is the T3 project's
`defaultModelSelection`, or else the last
choice for this Mimir project saved in the browser, when it is still offered.
Each option whose `default` is one of its `values` takes it, and the rest
are left out. The runtime
mode is the last one chosen for this Mimir project when the provider still
offers it, or else the broadest it may use: the ceiling is the access level
the operator granted at Connect, and threads meant to run unattended need it.
The workspace follows the system's `defaultThreadEnvMode` (`worktree`, or
else the project checkout), and plan mode is off. When the Mimir project has
no remote, or no reachable system has a matching T3 project, the launch control
shows that state, disabled. When reachable systems exist but no system,
project, or model can be picked this way, the control opens the settings
instead of launching.

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
- Deployments that use the T3 feature set `MIMIR_T3_URL`, `MIMIR_HOSTS`, a
  secret key, and, unless the console is used only on loopback, an HTTPS
  `MIMIR_URL`. On asgard `MIMIR_URL` and `MIMIR_HOSTS` are already set, and
  the key comes from the deployment's secret store.
- Rotating the secret key makes every host secret unreadable; each feature
  asks to connect again. No re-encryption step exists.
- The console stays unauthenticated on a single-user tailnet (ADR 0035), so a
  client that can reach it can use the stored T3 token through the console:
  with a full-access token, that means starting agent threads on every linked
  T3 system. The token itself never leaves the console server, and Host
  filtering keeps other websites from reaching it through the browser.
- A later integration follows the same shape: an address setting, an adapter
  in the console server, host secrets for its credentials, and generic writes.

## Refinement (2026-11-03, MMR-627): a thread started by hand records its T3 host

A task an agent queues or starts by hand inside a T3 thread recorded
`harness=t3` and the thread as its session (MMR-623), but no `host`, so it got
no Open in T3 link. T3 0.1.6 gives a thread's shell `T3CODE_THREAD_ID` but not
the environment id.

- **The environment id comes from `T3CODE_ENVIRONMENT_ID`.** Fleet sets it on
  each T3 server it runs, from that server's environment id (FLT-s11), and
  every thread's shell inherits it.
- **`queue` and `start` fill an omitted host from it** when
  `T3CODE_THREAD_ID` is nonblank and the main identity being recorded is that
  thread: `harness=t3` and the thread id as the session, whether the shell
  filled them or the agent passed them. The skill tells agents to pass both,
  so the fill cannot depend on the shell having filled them. A passed `--host`,
  blank included, wins. Another harness or session fills no host, because it
  may run on another machine. A start that keeps an established main identity
  or assigns a worker fills nothing, as with harness and session.
- **A missing or blank variable records no host and raises no error**, so the
  fill rolls out machine by machine with fleet.
- **Agents pass the host explicitly.** The skill tells an agent inside T3 to
  pass `host` as `$T3CODE_ENVIRONMENT_ID` when it is set, as it already passes
  the harness and session, so the record does not depend on the environment
  the CLI or the MCP server inherited.

**Considered and rejected.** Reading the id from
`$T3CODE_HOME/userdata/environment-id`, where T3 0.1.6 keeps it: the file is
T3's private storage, not a contract. Asking T3 where the thread lives when the
link is clicked: it adds a T3 call and a tool to the adapter for every link.

## Refinement (2026-11-05, MMR-629): the core also holds agent runs

"The core gains only the generic host-secret store" described this record's
first integration. [ADR 0041](0041-agent-runtime-on-the-host.md) adds a second
host-only table, `runs`, to the store's migrations for the agent runtime. The
boundary this record draws still holds for it: only the host reads or writes
the table, it stays out of the contract, the wire, the CLI, and the work-state
export, and the core gains no Engine verb or contract type for agents or for
any integration.

"Host secrets for its credentials" covers credentials a console flow obtains
at runtime, such as T3's OAuth token. A credential the operator supplies
ahead of time rides a mounted file instead, like `MIMIR_SECRET_KEY_FILE` and
`MIMIR_DATABASE_URL_FILE`: ADR 0041's agent token
(`MIMIR_AGENT_TOKEN_FILE`) and git credentials (`MIMIR_GIT_CREDENTIALS_FILE`)
do, because the unauthenticated console must not accept them.

## Refinement — delivery members are not launchable (2026-11-14, MMR-682)

The T3 launch's first check reads a live task naming a non-terminal delivery
as `not_ready`, before contacting T3. Membership reserves the task for the
delivery, so launch cannot queue it. A terminal delivery reference is not
membership (ADR 0042).

## Refinement (2026-11-16, MMR-679): the wake

A delivery's orchestrator often runs in a T3 thread
([ADR 0042](0042-the-delivery-record.md): `harness=t3`, `session` is the
thread, `host` is its environment). Without a signal, the agent learns that
the operator acted only at its next heartbeat's since read. The **wake** is
that signal. When the operator acts on a delivery or one of its decisions in
the console, the host sends a short message to the delivery's thread, after
the write commits.

### What wakes

The console gains one server function per operator action. Each waking
function calls its Engine method, then the wake. `confirm` calls its Engine
method only and answers the bare decision record.

| Console function  | Engine method     | Phrase in the message                       |
| ----------------- | ----------------- | ------------------------------------------- |
| `deliveryUnblock` | `deliveryUnblock` | `cleared the stop on delivery <d>`          |
| `deliveryPark`    | `deliveryPark`    | `paused delivery <d>`                       |
| `deliveryUnpark`  | `deliveryUnpark`  | `resumed delivery <d>`                      |
| `deliveryReturn`  | `deliveryReturn`  | `sent back the milestone of delivery <d>`   |
| `deliveryAbandon` | `deliveryAbandon` | `abandoned delivery <d>`                    |
| `deliveryUpdate`  | `deliveryUpdate`  | `edited delivery <d>`                       |
| `overturn`        | `overturn`        | `overturned decision <q> on delivery <d>`   |
| `confirm`         | `confirm`         | none: a confirm never wakes                 |

- **Only these console functions wake.** The Engine, the contract, the wire,
  the CLI, and MCP gain nothing. A write through `/trpc` never wakes, whoever
  sends it: the host cannot tell an operator's CLI from the agent's, and the
  agent would otherwise wake itself. The console is the operator's surface
  ([ADR 0035](0035-tanstack-start-container-host.md)), so a
  console write is the operator's. A change the operator makes from the CLI
  reaches the agent through its since read.
- **A confirm never wakes,** because it changes nothing the agent built on.
- **An overturn wakes only when the decision names a delivery.** It wakes
  whatever that delivery's lifecycle, because a terminal delivery keeps its
  handles ([ADR 0042](0042-the-delivery-record.md), *Handles*) and an overturn
  after `land` still names tasks to redo
  ([ADR 0043](0043-the-decision-record.md)). The same holds for every action:
  the wake reads the handles, never the lifecycle.
- The agent's own verbs (`deliveryCreate`, `deliveryStart`, `deliveryBlock`,
  `deliverySubmit`, `deliveryLand`, the lists, `decide`, `decisionUpdate`)
  get no console function here.
- **The console's existing task writes never wake,** member tasks included
  (`returnTask`, `block`, `annotate`, and the rest in `api/fns/nodes.ts`).
  They reach the agent through the since read, which reports a member's
  transitions and notes.

Each waking function takes its Engine method's input plus `attempt` (see
*The send*).

### Who receives it

The delivery as the write left it, so an `update` that changes the handles
wakes the new thread. The send goes to `threadId=<session>` on
`environmentId=<host>`. The checks run in this order, and the first that
fails ends the wake:

1. The T3 feature is enabled (`MIMIR_T3_URL` is set); otherwise `skipped`,
   `unconfigured`.
2. For an overturn, the decision names a delivery; otherwise `skipped`,
   `no_delivery`. The delivery is read through the Engine.
3. The delivery has `harness=t3` with a nonblank `session` and `host`;
   otherwise `skipped`, `no_thread`.
4. The feature's settings pass their check; otherwise `misconfigured`,
   because an operator who set the feature up expects the wake.
5. The sealed token opens and is current; otherwise `disconnected`.

A skip never reads the host secret, and a delivery read as not running in
T3 never raises a toast, so the operator is asked to fix T3 only for a wake
that was due. A delivery read that fails reads `failed`, whatever the
delivery's handles.

### The message

```text
Mimir: the operator overturned decision MMR-q4 on delivery MMR-d3. Read what changed: mimir get MMR-d3 --since 2026-11-16T09:10:02.310Z
```

- It is `Mimir: the operator <phrase>. Read what changed: mimir get <d> --since <since>`.
  The phrase is fixed per action and carries only ids. Nothing the operator
  typed reaches the thread (no reason, note, option, or field value); the
  agent reads those from Mimir, as data.
- `<since>` is the host's clock read just before the Engine write, minus one
  millisecond, in ISO 8601 with milliseconds. The write stamps its rows with
  the same process's clock at or after that read, and the since read selects
  events strictly after `since` (ADR 0042, MMR-692 refinement), so the
  command shows this action. An `update` writes no log row; the read's
  `delivery` snapshot carries the edit.
- One action sends one message. Nothing is batched, queued, or retried by the
  host.

### The send

The adapter adds `t3_thread_send` to its fixed tool list. It calls it with
`threadId`, `environmentId`, `message`, `mode: 'auto'`, and
`clientRequestId: mimir:wake:<attempt>`. `auto` starts an idle thread and
steers a running turn, so a long build turn sees the action at once. The
`attempt` is a random id the browser makes for one action, with the launch
attempt's grammar (16 to 64 of `[A-Za-z0-9_-]`); a Retry reuses it, so T3 can
treat it as the same send. A duplicate is harmless in any case: the message
only points at the since read.

Each request of the send uses the adapter's default 10-second timeout, as
every adapter call does. Opening the MCP session and sending take three
requests, so a T3 that answers slowly at each step can hold the answer for up
to about 30 seconds; the write is already saved. The server function waits
for the send, so its answer carries the outcome.

### The answer

A waking function answers `{ record, wake }`: `record` is the Engine method's
output, and `wake` is a tagged state.

| `wake.state`   | When                                                                                         | Console                                                       |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `sent`         | T3 accepted the send                                                                         | nothing more                                                  |
| `skipped`      | `reason`: `unconfigured`, `no_delivery`, or `no_thread` (see *Who receives it*)              | nothing more                                                  |
| `misconfigured` | The feature's settings fail their check (`setting` and `problem`, as for the catalog)        | warning toast linking to Devices                              |
| `disconnected` | No usable token: `reason` is `none`, `expired`, or `rejected`                                | warning toast with Reconnect T3                               |
| `unreachable`  | T3 did not answer, timed out, or sent an unreadable reply                                    | warning toast with Retry                                      |
| `refused`      | T3 answered the send with a tool error (`isError`), or has no send tool; carries `thread`    | warning toast with Open in T3 and Reconnect T3, naming the access-level cause |
| `failed`       | The wake faulted after the write: the delivery read failed, or an unexpected error           | warning toast with Retry                                      |
| `invalid`      | Only from `wakeT3`: `field` names the input that failed                                      | error toast                                                   |

- **Only `unreachable` and `failed` offer Retry, and they carry it** as
  `retry`: the `wakeT3` input that resends this wake,
  `{ delivery, action, decision, attempt, since }`, with `since` as the
  message used it and `decision` null except for an overturn. The delivery id
  is always known after the write (an overturn's record names it). The other
  failures need the operator to act first: Reconnect T3 leaves the page, and
  a refused send fails on every try until the connection or the thread
  changes; the operator's next action wakes the thread again.
- **`refused` carries `thread`**, `{ host, session }` from the delivery, so
  the console can build Open in T3 for an overturn too, whose record is a
  decision with no handles.
- **The wake never fails the write.** A refused Engine write throws as
  today and sends nothing. Once the write returns, every failure of the wake,
  a fault included, becomes one of these states; the function never throws
  after the write. A fault logs `t3_wake_fault` and reads `failed`.
- **The toast** says the write was saved and the thread was not told, and
  why: `T3 did not answer` for `unreachable`, `T3 refused the message` for
  `refused`, `connect T3 again` for `disconnected`, `T3 is not set up
  correctly` for `misconfigured`, and no cause for `failed`. `invalid` is a
  Retry's own error, worded for the field it names. For example `Saved. The T3 thread was not told: T3 did not
  answer.` A send T3 refuses on every try is most often a thread running with
  more access than Mimir's connection (T3 refuses a send to a thread with
  broader modes than the sender's), so the `refused` toast names that cause
  and offers Reconnect T3, to reconnect with full access, beside Open in T3. T3's text never reaches the console
  or a log, as for the launch.
- **Retry** calls `wakeT3` with a state's `retry`. It answers a `wake` state
  alone, with no `record`, and writes nothing to the store. It runs the checks
  of *Who receives it* again on the delivery read now, rebuilds the message from the
  action's fixed phrase and the given `since`, and sends with the same
  `clientRequestId`. Its input reads `invalid`, naming the field, when
  `action` is not a waking action; `delivery` does not parse as `KEY-dN`;
  `decision` is not a `KEY-qN` for an overturn or is not null otherwise;
  `attempt` breaks its grammar; or `since` is outside the since read's range.
  For an overturn, a decision that names another delivery reads `invalid`,
  naming `decision`, so a Retry cannot wake an unrelated thread. Retry does
  not re-check that the action happened: the console is the operator's own
  surface, and the message only points at the since read, which shows what
  did. The browser never names a T3 operation.
- **Each wake that is neither a skip nor `invalid` logs** `t3_wake` with its
  `outcome` and the delivery id, never the message; a `failed` wake logs
  `t3_wake_fault` in its place. A skip and an `invalid` Retry log nothing.

### Considered and rejected

- **Waking on every write, or on a CLI flag.** The host cannot tell who sent
  a `/trpc` write, and a flag would add an integration to the contract.
- **Batching actions over a short window.** It needs a timer and a pending
  queue in the host, and a restart during the window loses the wake.
- **Queue mode.** A message queued behind a long build turn arrives hours
  late, which defeats the wake.
- **Recording a failed wake on the delivery.** The adapter writes only the
  generic fields its verbs carry; a failed send is an integration state, so
  it stays in the console and the log.

## Refinement (2026-11-18, MMR-703): answering several decisions at once

The console's decisions walkthrough ([ADR 0019](0019-meridian-console-design-system.md),
MMR-703 refinement) collects answers to several provisional decisions and
writes them with one _Send_. One _Send_ is one operator action, so it sends at
most one message, under a new waking function. `confirm`, `overturn`, and
every function of the MMR-679 refinement keep their behavior. Three of that
refinement's statements about every waking function do not hold for
`answerDecisions`, and this section replaces them for it: it takes no single
Engine method's input, it answers `{ results, wake }` rather than
`{ record, wake }`, and a refused Engine write does not throw.

### The function

`answerDecisions` takes:

| Field      | Shape                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `attempt`  | The browser's id for this _Send_, with the grammar of _The send_                                                   |
| `delivery` | The delivery whose decisions the walkthrough shows (`KEY-dN`), or null for a project's decisions with no delivery |
| `answers`  | One to 100 answers, each naming a different decision                                                              |

Each answer is `{ id, verdict: 'confirm', note? }` or
`{ id, verdict: 'overturn', option?, note? }`. A confirm's note is its
outcome note. An overturn with `option` chooses another listed option, and
its note explains it; an overturn with a note and no option records an
answer outside the list ([ADR 0043](0043-the-decision-record.md)).

**Input checks.** Before anything is written, the call refuses with a
`validation` error, as an Engine input error does, when:

- `attempt` breaks its grammar;
- `delivery` is neither null nor a `KEY-dN`, or an answer's `id` is not a
  `KEY-qN`;
- two answers name the same decision. `delivery` and the answer ids are
  read in canonical form, so `MMR-q07` and `MMR-q7` are the same decision and
  `MMR-d03` is `MMR-d3`. Every later check, the wake, and the answer use the
  canonical form;
- the answers name decisions in more than one project, or in a project other
  than the delivery's;
- an answer breaks its shape: an unknown verdict, an `option` that is not a
  positive integer, or a non-string `note`. Whether an overturn has an option
  or a non-blank note is the Engine's check, per answer.

**The answers.** The function then works through the answers in the order
given. For each one:

1. It reads the decision through the Engine. A refused read, such as
   `not_found`, gives the outcome `refused` with the Engine's message. A
   decision that names a delivery other than `delivery`, or names one when
   `delivery` is null, gives `refused` with the reason that it is not in this
   walkthrough, and nothing is written for it. This keeps the wake on the
   thread that built on the answers. The read and the write are separate
   transactions, so a decision moved to another delivery between them is
   still answered; the wake then reaches the thread the walkthrough named.
2. It calls `confirm` or `overturn`. An Engine refusal, a `MimirError` with
   the code `not_found`, `validation`, or `conflict`, gives `refused` with the
   Engine's message, and the function moves on. A decision already confirmed
   or overturned elsewhere is refused here, by the Engine.
3. Any other error, a `MimirError` with the code `invariant` included, gives
   the outcome `failed`, logs `decision_answer_fault` with the decision id,
   and the function moves on.

Each answer is its own Engine write, as it is from the chips, so a refusal
never undoes or blocks another answer. Once the input checks pass, the
function never throws.

### The wake

After the last answer, the function wakes the delivery's thread at most once.
The checks run in this order, and the first that fails ends the wake:

1. The T3 feature is enabled; otherwise `skipped`, `unconfigured`.
2. `delivery` is not null; otherwise `skipped`, `no_delivery`.
3. At least one answer's outcome is `overturned`; otherwise `skipped`, the
   new reason `no_overturn`. A _Send_ of confirms wakes nothing, as a single
   confirm does.
4. Checks 3 to 5 of _Who receives it_, on the delivery read after the
   writes: `no_thread`, `misconfigured`, `disconnected`.

- **Action and phrase.** The action is `answerDecisions`, named for the
  console function, because no single Engine method backs it. Its phrase is
  `answered decisions on delivery <d>`. The phrase is fixed and carries only
  the delivery's id; the since read shows which decisions moved and how.
- **Since.** `<since>` is the host's clock read just before the first
  answer's read, minus one millisecond, so the since read shows every answer
  of the _Send_.
- **Retry.** `retry` is
  `{ delivery, action: 'answerDecisions', decision: null, attempt, since }`.
  `wakeT3` accepts `answerDecisions` with a null `decision`, and reads
  `invalid`, naming `decision`, when one is given.
- **Logs.** The wake logs `t3_wake` and `t3_wake_fault` as every wake does.
- **A lost answer.** When the browser never receives the answer to a _Send_
  and sends again, the second _Send_ finds the decisions answered: every
  answer reads `refused`, and the wake skips at the first check that fails,
  `no_overturn` when T3 is enabled and the set names a delivery. The first
  _Send_'s `retry` is lost with its answer, so if its wake was not delivered
  either, the agent learns of its overturns from its since read.

### The answer

`answerDecisions` answers `{ results, wake }`. `results` holds one entry per
answer, in input order: `{ id, outcome: 'confirmed' | 'overturned', record }`
with the Engine's decision record, `{ id, outcome: 'refused', reason }`, or
`{ id, outcome: 'failed' }`, each with the decision's canonical id. A `reason` is the Engine's message or the
membership reason, never text the operator typed. `wake` is a state of _The
answer_'s table, with `skipped` gaining the reason `no_overturn`. The console
shows the wake state as it does for every waking function.

### Considered and rejected

- **One store transaction for the whole _Send_.** All or nothing would need a
  new Engine method and a contract change, and it would hold back every
  answer because one decision was answered elsewhere. Decisions are
  independent records, so each answer stands alone.
- **One wake per overturn.** A _Send_ that overturns three decisions would
  start or steer the agent's turn three times for one operator action.
- **Waking for confirms with notes.** A confirm changes nothing the agent
  built on; the agent reads a confirm's note through its since read.
