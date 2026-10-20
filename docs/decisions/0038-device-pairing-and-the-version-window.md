---
title: 'ADR 0038: Device pairing and the version window'
description: A remote CLI pairs once with a host and sends a bearer device token and its version on every tRPC call. The host refuses clients outside a compatibility window, and an operator administers devices through mimir-host.
status: accepted
date: 2026-10-20
---

# ADR 0038: Device pairing and the version window

ADR 0034 put every operation behind the Engine and gave remote clients a tRPC
wire. It left three transport concerns to the phase that makes the CLI remote:
the token check, the version gate, and the pairing rate limit. ADR 0035 kept
the console unauthenticated on a single-user tailnet and deferred the token
check for the CLI and MCP until device pairing lands. This record settles how
a CLI pairs with a host, how the two agree on versions, and how an operator
administers paired devices.

## The decision

### A device pairs once and then sends a bearer token

_The code-issue part of this section is superseded by the 2026-10-20 addendum (MMR-584). The bearer check and its order stand._

The operator names a device on the host, and the host issues a one-time
pairing code for it. The CLI on that device redeems the code and receives a
device token. The CLI then sends the token as `Authorization: Bearer` on every
Engine procedure under `/trpc`. A missing, unknown, or revoked token is
refused with one `unauthorized` error.

A pairing code is 8 Crockford base32 characters, printed as `XXXX-XXXX`, and
is valid for 10 minutes. It is read case-insensitively, with the hyphen
optional and Crockford's confusable letters folded. A device token is 256
random bits, base64url-encoded.

The host guard (ADR 0035) runs first, then the version window, then the bearer
check. The redeem endpoint and `/health` are host routes outside the Engine
and outside the bearer check. The console reaches the Engine through its server
functions, not through `/trpc`, so neither the version window nor the bearer
check applies to it, and its server functions require no token. The
`console.*` procedures on `/trpc` (ADR 0034 Decision 6) take both checks like
every other procedure.

### Codes and tokens are host transport credentials

_The `pairing_codes` table is superseded by the 2026-10-20 addendum (MMR-584). `device_tokens` and the token lifecycle stand._

Migration 0009 adds two tables in both dialects:

- `pairing_codes`: `device` (primary key), `code_hash`, `created_at`, and
  `expires_at`. A new code for a device replaces its pending code, and
  redeeming a code deletes it.
- `device_tokens`: `id`, `user` (text, default `'owner'`), `device`,
  `token_hash` (unique), `created_at`, `last_used_at`, and `revoked_at`. A
  partial unique index allows one active token per device.

The store keeps only SHA-256 hashes of codes and tokens. Redeeming a code for a
device that has an active token revokes that token, so pairing again rotates
it. Revoking sets `revoked_at` and keeps the row. `last_used_at` is updated
only when it is more than 5 minutes old, so a busy client does not write on
every call.

Codes live in the store, not in host memory, because `mimir-host pair` runs as
a separate process from the server. Codes and tokens are transport
credentials: a host-only core module manages them, they are not on the Engine,
and the transfer document excludes them. Moving a board to another host means
pairing its devices again. A CLI-only SQLite store carries the two tables
empty.

### Clients and hosts agree on a version window

The client sends `x-mimir-version` on every tRPC request. Host middleware
refuses a request, as a `MimirError` with its remedy, when:

- the client is older than the host's `MIN_CLIENT`. The remedy is to update
  this CLI.
- the client is newer than the host by minor version. The remedy is to update
  the host first. Engine inputs are strict objects, so a newer client can send
  a field an older host refuses.
- the header is missing. A missing header is outside the window.

A client inside the window works. `/health` advertises the host's `version`
and `minClient`, so a client can check the window before it pairs.

`MIN_CLIENT` is a constant in `@mimir/contract`. It is raised by hand when an
Engine change breaks older clients. CI holds a checked-in JSON Schema snapshot
of the Engine schemas, and a test fails on any change until the snapshot is
regenerated. The reviewer of the regeneration diff decides whether the change
breaks older clients and so whether `MIN_CLIENT` rises. No tool classifies the
diff automatically.

The window admits versions, so the Engine contract changes only in a minor
release. A patch release leaves the schemas unchanged, which lets a client
newer than the host by patch call nothing the host lacks. Additive changes
stay inside the window for older clients: a new method, a new optional input,
or a new output field. `RemoteEngine` does not parse Engine outputs, so an
older client ignores a field it does not know. MCP needs no rule of its own: an
older CLI exposes its own, smaller tool set.

The upper bound compares major and minor versions only, and prereleases are no
exception. The `MIN_CLIENT` floor is a full SemVer comparison. A host at `0.26.0-next.47` admits a client at `0.26.0-next.48`, even
though the newer client may send a field the host refuses as a plain
validation error, without the update-the-host remedy. Prereleases are
development builds, and the host-first update order already covers them.
Untagged development builds all report the same `-next` version, so a stricter
prerelease order could not tell them apart.

Until the CLI's direct-Postgres mode retires, a CLI that opens a shared
Postgres store directly keeps ADR 0030's exact schema gate. Direct database
access has no contract that a window could hold compatible.

### The redeem limit is host-wide

_Superseded by the 2026-10-20 addendum (MMR-584)._

Every failed redeem answers one uniform `400`, whether the code is unknown,
expired, or already used. After 5 failed redeems in a rolling 10 minutes, the
host refuses every redeem, valid codes included, with `429` and `Retry-After`
until the window slides. The `429` reveals nothing about whether a code is
valid. The counter is in memory, so a restart resets it. Each failed redeem is
logged with its time and never with the attempted code.

The limit counts failures for the whole host, not per address. Behind Caddy and
the tailnet a client's address is not trustworthy. Bearer checks are not
limited, because a 256-bit token cannot be guessed.

### The CLI keeps its credentials beside its config

_The origin-mismatch remedy is refined by the 2026-10-20 addendum (MMR-584)._

`config.toml` holds exactly one of `[host]` and `[store]`. Holding both is a
configuration error that names the fix. `[host]` holds the host's `url`.

`credentials.toml` lives beside `config.toml` in the CLI's runtime config
directory, under the same live, sandbox, and development authority (ADR 0031).
It holds `origin`, `device`, `token`, and `issued_at`. The CLI writes it
atomically: it creates a temporary file with mode `0600` and renames it into
place. The CLI refuses:

- a credentials file readable by group or others. The remedy is
  `chmod 600`.
- to send a request when the origin of `[host].url` differs from the recorded
  `origin`. The remedy is `mimir pair <url> <code>`.

### `mimir pair` connects a CLI to a host

_The steps are superseded by the 2026-10-20 addendum (MMR-584). The `doctor` and `store` paragraphs stand._

`mimir pair <url> <code>`:

1. Reduces the URL to its origin. It accepts `http` and `https`.
2. Normalizes the code as the host does.
3. Refuses when `config.toml` has `[store]`, and lists the migration steps. It
   never removes `[store]` itself.
4. Checks `/health` and the version window before it redeems.
5. Sends only the code. The device name is the one the operator gave on the
   host.
6. Writes `credentials.toml`, and then `[host] url` in `config.toml`.
7. Prints `paired as <device> with <origin> (host <version>)`.

Pairing again when `[host]` is set replaces both files, which rotates the
token. The CLI has no `unpair`, because revocation happens on the host.
`mimir pair` is machine-local, so it is not an MCP tool. It takes its input as
arguments and does not prompt.

In remote mode, `mimir doctor` checks the client side in this order and stops
at the first blocking failure:

1. exactly one of `[host]` and `[store]` is set;
2. the credentials file exists with mode `0600`;
3. the recorded origin matches `[host].url`;
4. `/health` is reachable;
5. the CLI's version is inside the host's window;
6. the host accepts the token on one `projects` call.

Every finding carries its remedy. The report ends by pointing to
`mimir-host doctor` for record health. In remote mode, `mimir store` refuses
and points to `mimir-host`. In local mode it is unchanged.

### `mimir-host` administers the host

`mimir-host` is a Loom application in `packages/host` and is on the image's
`PATH`. An operator runs it as `docker exec mimir-host mimir-host <command>`.
It reads the host configuration and opens the host's store. It never
migrates: the host migrates on boot (ADR 0035), and `mimir-host` refuses a
schema that does not match its own.

| Command | Effect |
| --- | --- |
| `pair <device>` | Prints a pairing code, and notes when an active token will be replaced. _Superseded by the 2026-10-20 addendum (MMR-584)._ |
| `unpair <device>` | Revokes the device's token and keeps the row. |
| `tokens [--all]` | Lists user, device, created, last used, and revoked. |
| `doctor` | Reports the record-health facet that the console reads. |
| `store export <file\|->` | Writes the transfer document. |
| `store import <file\|-> [--apply] [--resume]` | Reads a transfer document. Standard input works with `docker exec -i`. |

`mimir-host` has no `store upgrade`.

### Pairing is groundwork for identity, not a security boundary

The console stays unauthenticated (ADR 0035). Its server functions carry full
Engine authority, so anyone who can reach the host can read and change its
store without a token. Pairing names each device, shows when it was last used,
and lets the operator revoke it. Every token belongs to the `user` `'owner'`
on a single-user host. On a single-user tailnet, the tailnet is still the security
boundary. Pairing does not make a host safe to expose beyond it.

## Why

- **A window decouples releases from client updates.** Under an exact-minor
  gate, every release would force every CLI to update, including releases
  that change nothing a client calls. The window refuses only the clients a
  change actually breaks, and it refuses them with a remedy.
- **Refusing newer clients protects strict inputs.** Engine inputs reject
  unknown fields, so an older host could refuse a newer client's call. The
  window refuses the newer client first, with the remedy.
- **A snapshot makes every contract change visible.** A reviewer reads the
  schema diff and decides. A missed change fails CI instead of failing a
  client in the field.
- **Hashed, rotating tokens limit what a leak exposes.** A store dump holds no
  usable token, pairing again revokes the old one, and revocation leaves a
  record.
- **Keeping credentials off the Engine keeps them out of every transport.** A
  local CLI has no token to check, and the transfer document cannot carry a
  credential to another host.

## Considered and rejected

- **An exact-minor version gate.** It is simpler, but it forces an update on
  every release whether or not the contract changed.
- **Automatic classification of breaking changes.** Deciding whether a schema
  change breaks older clients needs judgment. A reviewer reading the snapshot
  diff decides, and the test guarantees that the diff reaches review.
- **A per-address redeem limit.** Client addresses are not trustworthy behind
  Caddy and the tailnet.
- **Pairing codes held in host memory.** `mimir-host pair` runs in a separate
  process, so it cannot reach the server's memory.
- **Carrying tokens in the transfer document.** A token belongs to the host
  that issued it. Moving hosts means pairing again.
- **A client-side `unpair`.** Deleting a local file does not revoke a token.
  Revocation belongs on the host.

## Consequences

- ADR 0034 Decision 5 and ADR 0035's authentication paragraph gain dated
  refinements that point here.
- The CLI-only-to-host migration and the shared-Postgres cutover follow this
  record's commands. The CLI's direct-Postgres mode retires as the cutover's
  last code change: the CLI's `[store]` accepts SQLite only, Postgres becomes a
  host-only backend, and the CLI's `store upgrade` goes away. ADR 0030 is
  amended, and ADR 0032's sharing boundary reconciled, in that change.
- The host gains a store migration, so its first pairing release follows the
  host-first update order. Direct-Postgres CLIs refuse the new schema under
  ADR 0030's gate until they are updated.

## Addendum (2026-10-20, MMR-584): the client requests pairing and the host approves it

The client starts pairing and the operator approves it on the host, as in
`gh auth login` and the OAuth device authorization grant (RFC 8628). This
replaces the host-minted pairing code, `mimir-host pair`, and the redeem
endpoint. Bearer tokens, the version window, and the token lifecycle are
unchanged.

### The flow

1. The client sends `POST /auth/pairing/requests` with `{"device": "<name>"}`.
   The host trims the name and refuses one that is empty, longer than 128
   characters, or holds a control character.
2. The host stores a pairing request and answers `user_code`, `poll_secret`,
   `expires_at`, and `interval`. The user code is 8 Crockford base32
   characters, displayed as `XXXX-XXXX` and read as pairing codes were read:
   case-insensitively, with the hyphen optional and confusable letters folded.
   The poll secret is 256 random bits, base64url-encoded. A request is valid
   for 10 minutes, and `interval` is 2 seconds.
3. The client displays the user code and polls `POST /auth/pairing/poll` with
   `{"poll_secret": "<secret>"}` every `interval` seconds.
4. The operator approves or denies the request on the host by its user code.
5. A poll answers `pending`, `denied`, `expired`, or `approved` with `device`
   and `token`. The first approved poll mints the device token, revokes the
   device's active token, and deletes the request in one transaction, so a
   second poll cannot mint again. A denied request answers `denied` once and
   is then deleted. An unknown, consumed, or expired poll secret answers
   `expired`, so a poll reveals nothing about secrets it does not hold.

A request that has expired never matches, approved or not. A device has at
most one request: a new request replaces the earlier one, as a new code
replaced a pending code. Both pairing routes are host routes outside the
version window and the bearer check, like the redeem endpoint before them.

### Two values separate naming a request from collecting it

The user code only identifies the request to the operator. Only the holder of
the poll secret collects the token, and only the client ever sees the secret.
Someone who sees the client's screen, or watches the operator type the code,
cannot take the token.

The store keeps only SHA-256 hashes of user codes, poll secrets, and tokens. A
hash cannot be turned back into a code, so the pending listing shows each
request's device, creation time, and expiry, and the operator reads the code
from the client's screen.

### The limit moves to request creation

The user code is typed only on the host, so it cannot be guessed over the
network, and the poll secret is as unguessable as a token. A network client
can still file requests. After 10 requests in a rolling 10 minutes, the host
refuses every new request with `429` and `Retry-After` until the window
slides. As before, the limit counts the whole host, lives in memory, and
resets when the host restarts. A malformed body answers one uniform `400`,
creates nothing, and does not count. A store fault does not count. Polls are
not limited, and a malformed poll answers a uniform `400`.

### Migration 0010 replaces the codes table

Migration 0009 has shipped, so it stays as written. Migration 0010 drops
`pairing_codes` and creates `pairing_requests` in both dialects: `id`,
`device` (unique), `user_code_hash` (unique), `poll_secret_hash` (unique),
`created_at`, `expires_at`, `approved_at`, and `denied_at`. A check refuses a
request that is both approved and denied. `device_tokens` is unchanged. A code
pending at upgrade is lost, which costs at most one 10-minute pairing. Filing
a request purges expired ones. Pairing requests, like tokens, stay out of the
transfer document.

### `mimir pair` requests and waits

`mimir pair <url> [--device <name>]` replaces `mimir pair <url> <code>`. The
device name defaults to the machine's hostname. The command:

1. Reduces the URL to its origin. It accepts `http` and `https`.
2. Refuses when `config.toml` has `[store]`, and lists the migration steps.
3. Checks `/health` and the version window before it files a request.
4. Files the request and prints the user code with the `mimir-host approve`
   command to run on the host.
5. Blocks and polls at the host's interval until a terminal answer.
6. On approval, writes `credentials.toml`, and then `[host] url` in
   `config.toml`, and prints `paired as <device> with <origin> (host <version>)`.
   On `denied` or `expired`, it writes nothing and exits non-zero.

The credentials file's origin-mismatch remedy becomes `mimir pair <url>`. The
command still takes its input as arguments and does not prompt.

The `mimir-host` table replaces `pair <device>` with three commands:

| Command | Effect |
| --- | --- |
| `pending` | Lists live requests awaiting a decision: device, created, and expires. |
| `approve <code>` | Approves the request, and notes when an active token will be replaced. |
| `deny <code>` | Denies the request. |

`mimir-host approve` is the only approval surface for now. Approval from the
console is follow-up work (MMR-585).

### Why

- **The operator's approval is the decision that matters.** On a single-user
  tailnet, the host trusts a device because the operator admitted it. The
  request flow keeps that decision on the host.
- **The operator should not have to start every pairing on the host.** With
  host-minted codes, pairing a laptop meant opening a shell on the host first,
  then carrying a code across. Now the client starts, and the operator
  confirms a code already on screen.
- **Two values keep a seen code harmless.** The code shown on screen cannot
  collect the token, so displaying it costs nothing.

### Considered and rejected

- **Host-minted codes, the original decision.** They made the operator start
  every pairing from the host. Under the tailnet threat model the operator's
  approval is what matters, and the request flow keeps that approval while
  letting the client start.
- **One code that both identifies the request and collects the token.**
  Anyone who saw the code could poll for the token before the client did.
- **User codes stored recoverably, so the pending listing can show them.**
  The listing would hold live credentials in the clear. The code is already on
  the client's screen.
- **A redeem-style limit on polls.** A 256-bit poll secret cannot be guessed,
  as a bearer token cannot.
