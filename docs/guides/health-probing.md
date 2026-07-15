# Health probing

## `/api/health` is a liveness ping, not a store check

`GET /api/health` returns `{ status: 'ok', version, schema }` unconditionally
— it never touches the vault or the store. A `200` from `/api/health` tells
you the HTTP server is up and which build/schema it is; it tells you nothing
about whether the store behind it is usable. Don't use it as a "is mimir
healthy" probe.

## Probe `/api/nodes` for real health

`GET /api/nodes` (or any other store-backed endpoint) actually exercises the
store. If you want to know whether mimir can serve real requests — not just
whether the process is alive — probe that instead. `mimir service status`
does the equivalent for you already (it probes the daemon's health endpoint
and reports the running/on-disk version skew), so reach for a raw HTTP probe
only when scripting something status doesn't cover.

## Reading a 409

Every store-backed endpoint runs through a shared error envelope
(`packages/bin/src/http/respond.ts`). The envelope's `code` maps to an HTTP
status:

| code         | HTTP status |
| ------------ | ----------- |
| `validation` | 400         |
| `not_found`  | 404         |
| `conflict`   | 409         |
| `invariant`  | 409         |

A `409` from the HTTP surface means `conflict` or `invariant` — a broken
store or a violated invariant, not a client mistake. `invariant` errors are
raised by the Norn layer (`packages/bin/src/norn/*`, `core/store-norn.ts`)
when the vault's own consistency guarantees are violated (a referenced node
vanished mid-transaction, a stem resolved unexpectedly, and so on); the
message on the envelope is that Norn error, verbatim — read it, don't guess.
A `400` (`validation`), by contrast, is an ordinary tool-level refusal: a
malformed request body, a missing required field, an unknown enum value.
`409` is the signal that something is actually wrong with the vault, not with
the request you sent.
