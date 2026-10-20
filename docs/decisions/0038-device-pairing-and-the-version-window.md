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
and outside the bearer check. The console's server functions do not require a
token.

### Codes and tokens are host transport credentials

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

Additive changes stay inside the window: a new method, a new optional input,
or a new output field. `RemoteEngine` does not parse Engine outputs, so an
older client ignores a field it does not know. MCP needs no rule of its own: an
older CLI exposes its own, smaller tool set.

Until the CLI's direct-Postgres mode retires, a CLI that opens a shared
Postgres store directly keeps ADR 0030's exact schema gate. Direct database
access has no contract that a window could hold compatible.

### The redeem limit is host-wide

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
| `pair <device>` | Prints a pairing code, and notes when an active token will be replaced. |
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
