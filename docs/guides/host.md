---
description: Run the Mimir host container on Docker Desktop or a server, reach it safely, check its health, administer it, upgrade it, and back up its store.
---

# Run the Mimir host

The host image, `ghcr.io/dbtlr/mimir-host`, carries the console, the Engine
endpoint at `/trpc`, and the store
([ADR 0035](../decisions/0035-tanstack-start-container-host.md)). It reads its
configuration from environment variables, migrates its store before it serves,
and needs no CLI installation. `deploy/compose.yaml` runs it over SQLite, and
`deploy/compose.postgres.yaml` layers Postgres on top.

## Keep the console on a single-user tailnet

The console requires no authentication. Any client that reaches its port can read and
write the whole board through console server functions. `/trpc` requires a paired
device token. The Host
allowlist and the cross-origin write check guard against hostile web pages,
not against people.

Publish the port on loopback only, as `deploy/compose.yaml` does, and reach it
from other devices through [`tailscale serve`](#use-tailscale-serve) on a
tailnet that only you use. Do not publish the port on a LAN or internet
address. Do not use `tailscale funnel`, which publishes to the internet.

## Run it on Docker Desktop with SQLite

From the repository root, start the host:

```sh
docker compose -f deploy/compose.yaml up -d --wait
```

`--wait` returns when Docker reports the container healthy. Open
`http://localhost:64647/`. Loopback is a secure context, so the console
installs as a PWA and keeps its offline reads.

The store is `store.sqlite` in the `mimir_data` volume, mounted at `/data`.
The first start logs each migration it applies:

```text
host: applied migration 0001_init
…
host: applied migration 0005_project_pinned
```

To use another local port, change the published side of the mapping, such as
`127.0.0.1:8080:64647`. `MIMIR_PORT` changes the port inside the container
instead. If you set it, change the container side of the mapping to match.

## Run it on a server against Postgres

The host reads the Postgres URL from a mounted file, so the password stays out
of the Compose file and the container's environment. Only an image built from
the repository's `Dockerfile` can open a live Postgres URL. A development host
refuses one
([ADR 0035](../decisions/0035-tanstack-start-container-host.md#the-image-owns-live-store-authority)).

1. Create `deploy/secrets/` closed to other users, and write the password for
   the bundled Postgres service:

   ```sh
   mkdir -m 700 -p deploy/secrets
   openssl rand -hex 24 > deploy/secrets/postgres-password
   ```

2. Write the connection URL with the same password. The host is the
   `postgres` service:

   ```sh
   printf 'postgres://mimir:%s@postgres:5432/mimir\n' "$(cat deploy/secrets/postgres-password)" > deploy/secrets/database-url
   ```

3. Make both files readable inside the containers:

   ```sh
   chmod 644 deploy/secrets/*
   ```

4. Start both services:

   ```sh
   docker compose -f deploy/compose.yaml -f deploy/compose.postgres.yaml up -d --wait
   ```

Compose mounts each secret file with its permissions from the server. The host
runs as the image's `bun` user, UID 1000, and Postgres reads its password as
its own user, so each file must be readable inside its container. The `700`
directory keeps the readable files private from other accounts on the server.
Git ignores `deploy/secrets/`, and the image build ignores it too.

To use a Postgres server you already run, remove the `postgres` service and
the `depends_on` entry from `compose.postgres.yaml`. Then write that server's
URL to `deploy/secrets/database-url`. The host creates or migrates the schema
on start.

The bundled service also listens on `127.0.0.1:5433` of the server, so a CLI
on the same machine can open the database directly. Its `[store] url` names
that address with the same password, such as
`postgres://mimir:<password>@127.0.0.1:5433/mimir`
([Configure](postgres-store.md#configure)). Set `MIMIR_POSTGRES_PORT` in
`deploy/.env` to use another port. A CLI on another machine needs a Postgres
server that it can reach, so use a server you already run.

`MIMIR_DATABASE_URL` takes the URL directly, for a platform that injects it
as a variable. Setting both `MIMIR_DATABASE_URL` and
`MIMIR_DATABASE_URL_FILE` refuses startup.

## Reach it from another device

The container listens on every interface inside its network namespace.
The port mapping decides who outside the container can connect.

### Use tailscale serve

`tailscale serve` is the recommended way in. On the machine that runs the
container, proxy your tailnet's HTTPS name to the loopback port:

```sh
tailscale serve --bg 64647
```

The console is then at `https://<machine>.<tailnet>.ts.net/`, for devices on
the tailnet only. The tailnet needs MagicDNS and HTTPS certificates turned on.
Tailscale terminates TLS with a `ts.net` certificate, so the PWA installs and
works offline. Tailscale keeps the browser's `Host` header, so console writes
pass the cross-origin check. `tailscale serve reset` removes the proxy.

### Use a reverse proxy

A proxy that terminates TLS on the same machine forwards to the loopback port.
The proxy itself must listen only on the tailnet address, or it puts the
unauthenticated console on every network the machine is on. In this Caddy
example, `bind` holds the site to the machine's tailnet address:

```caddyfile
mimir.example.local {
	bind 100.64.0.7
	reverse_proxy 127.0.0.1:64647
}
```

A proxy that runs in its own container cannot reach the server's loopback.
Attach it to the host's Compose network, `mimir_default`, and forward to
`mimir:64647`. Publish the proxy container's ports on the tailnet address
only, such as `100.64.0.7:443:443`, not on every interface.

The proxy owns TLS. Authentication at the proxy does not widen the accepted
boundary, which stays the single-user tailnet. The proxy must forward the
browser's `Host` header, which Caddy does by default. A proxy that rewrites
`Host` to the upstream address makes the host refuse console writes.

### Publish on a network address

Publishing the port on a LAN or internet address opens the board to anyone who
can reach it, with no authentication. To listen on one address instead of every
interface, put the address in the mapping, such as the machine's tailnet
address (`100.64.0.7:8080:64647`). Plain HTTP on an address other than loopback
is not a secure context, so the console works as a page but does not install as
a PWA or keep offline reads.

## Configure the host

The host reads these variables at start and refuses startup with a message
that names an invalid one. It does not read the CLI's `config.toml`.

| Variable                  | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `MIMIR_DATABASE_URL_FILE` | Read a Postgres connection URL from this file, such as a mounted secret.                 |
| `MIMIR_DATABASE_URL`      | Use this Postgres connection URL.                                                        |
| `MIMIR_DATA_DIR`          | The SQLite directory when neither URL variable is set. The image sets `/data`.           |
| `MIMIR_URL`               | The console's public `http` or `https` origin, with no path.                             |
| `MIMIR_HOSTS`             | Turn on the Host allowlist: comma-separated bare hostnames. An empty value is allowed.   |
| `MIMIR_PORT`              | The port inside the container, `64647` by default.                                       |

By default the host answers any `Host` header. Setting `MIMIR_HOSTS` adds
optional protection against DNS rebinding: the host then answers only
`localhost`, `127.0.0.1`, `[::1]`, each listed name, and the host of
`MIMIR_URL`, and refuses every other name with a 403. List every name you
reach the console by, such as the `ts.net` name or the proxy's name. The log
names each refused hostname once. `MIMIR_URL` alone does not turn on the
allowlist.

Binding loopback does not stop DNS rebinding: a web page whose domain resolves
to `127.0.0.1` is same-origin with the host, and it sends its own name as the
`Host` header. Set `MIMIR_HOSTS` when the machine that runs the console's
browser also browses untrusted sites.

The host always refuses a browser write from another origin, with the
`forbidden_origin` error. The CLI and other clients that send no `Origin`
header pass.

## Check health

`GET /health` returns `status`, `version`, `minClient`, and the supported `schema`
without a token or a store query. The host answers no request until its store has opened
and migrated, so a 200 means the store was usable at boot. It does not prove
that the store is reachable now. The image's Docker health check probes
`/health` over loopback every 10 seconds. `docker compose ps` shows the
result.

A configuration or store failure at boot exits the host process. With
`restart: unless-stopped`, Docker restarts the container repeatedly and
`up --wait` fails. `docker compose logs mimir` names the cause:

```text
host: startup refused: MIMIR_PORT must be an integer from 1 to 65535
```

To prove that the store answers now, read it through the Engine endpoint. This
request lists the active projects. It is a `GET` with a [superjson](https://github.com/flightcontrolhq/superjson)
input, so pass the input as a query parameter. Set `MIMIR_DEVICE_TOKEN` to a paired
device token and `MIMIR_CLIENT_VERSION` to the calling client's build version:

```sh
curl --fail --silent --show-error --get http://127.0.0.1:64647/trpc/projects \
  --header "Authorization: Bearer $MIMIR_DEVICE_TOKEN" \
  --header "x-mimir-version: $MIMIR_CLIENT_VERSION" \
  --data-urlencode 'input={"json":{}}'
```

A healthy host answers `200` with a body that starts `{"result":{"data":{"json":[`,
followed by the project list. A store the host cannot read answers `500`, which
`--fail` turns into a non-zero exit. The console's Record health page shows the
findings that `mimir doctor` reports.

The retired `/api` answers every method with `410` and a JSON body whose error
code is `gone` and whose hint names `/trpc`, so a stale probe such as
`curl --fail .../api/projects` fails instead of passing on the console's HTML.
Besides that tombstone, the host serves `/health`, `/auth/pairing/requests`, `/auth/pairing/poll`, `/trpc`, the console's
server functions under `/_serverFn`, and the console itself. The host guard
covers every one of them. Any other path under `/auth`, including the removed
`/auth/pairing/redeem`, answers `404` with a JSON body whose error code is
`not_found`.

## Pair a device

A client asks to pair, an operator approves the request on the host, and the
client polls until it collects its device token. Both pairing routes require
neither a bearer token nor a version header. Responses set
`Cache-Control: no-store`, and other methods return `405` with `Allow: POST`.

`POST /auth/pairing/requests` accepts JSON `{"device":"device-name"}`. The host
trims the name. A missing, empty, or non-string name, a name longer than 128
characters, a name with a control character, or a body that is not JSON
returns the same `400` body: `{"error":"invalid pairing request"}`. A valid
request returns:

```json
{
  "user_code": "XXXX-XXXX",
  "poll_secret": "poll-secret",
  "expires_at": "2026-10-20T12:10:00.000Z",
  "interval": 2
}
```

The client displays `user_code` for the operator and keeps `poll_secret` to
itself. A request is valid for ten minutes. A new request for the same device
replaces its pending or denied request. While the device has an approved
request that its client has not collected, a new request returns `409`:

```json
{
  "error": "this device has an approved pairing request awaiting collection",
  "hint": "deny or unpair the device on the host, or wait for the approval to expire"
}
```

Each request logs the device and the time,
never the code or the secret. After ten requests in a rolling ten minutes,
every new request returns `429` with `Retry-After` in seconds. The limit
covers the whole host and resets when the host restarts. Malformed requests,
`409` refusals, and store faults create nothing and do not count toward it.

The operator approves or denies the request on the host by its user code,
in the console (see [Pair devices from the console](#pair-devices-from-the-console))
or with [`mimir-host`](#administer-the-host-with-mimir-host). The code is read
case-insensitively, with the hyphen optional. Denying an approved request that
its client has not collected withdraws the approval, and the next poll answers
`denied`. Unpairing a device discards its requests, so an approval it has not
collected never mints a token. From a shell:

```sh
docker compose -f deploy/compose.yaml exec mimir mimir-host pending
docker compose -f deploy/compose.yaml exec mimir mimir-host approve K7QM-2P9D
```

`POST /auth/pairing/poll` accepts JSON `{"poll_secret":"poll-secret"}`. Poll
every `interval` seconds. Each answer is a `200` with a `status`:

| `status` | Meaning |
| --- | --- |
| `pending` | The operator has not decided. Poll again. |
| `approved` | The body also holds `device` and `token`. The request is consumed. |
| `denied` | The operator denied the request. The request is consumed. |
| `expired` | The request expired, was consumed, or never existed. |

The first approved poll returns the token once. It also revokes the device's
earlier token, so pairing again rotates it. If that answer is lost in transit,
pair the device again: its earlier token was already revoked at mint. A body without a string
`poll_secret` returns `400` with `{"error":"invalid pairing poll"}`. Polls are
not rate limited.

A credential-store fault on either route returns a generic `500` with
`Cache-Control: no-store`. The fault log records the event and time without
driver details, codes, or secrets.

Every `/trpc` procedure, including `console.*`, requires `Authorization: Bearer`
with an active device token. The host guard runs first, then the version window,
then the bearer check. Console server functions use the local Engine and require
neither header. See [ADR 0038](../decisions/0038-device-pairing-and-the-version-window.md)
for the credential lifecycle and compatibility window.

### Pair the CLI with a host

`mimir pair` files the request, shows the code to approve, waits for the
decision, and then saves the result. It needs no config, and it repairs a
broken `[host]` or credentials file:

```sh
mimir pair http://mimir.example.ts.net:64647
```

```text
pairing code K7QM-2P9D
approve with mimir-host approve K7QM-2P9D on the host
or open http://mimir.example.ts.net:64647/pair?code=K7QM-2P9D
the request expires at 2026-10-21 14:32 EDT
Waiting for approval
[ok] paired as laptop with http://mimir.example.ts.net:64647 (host 0.26.0)
```

The code, approval command, console link, and expiry go to stderr. The final
line goes to stdout. With `-f json` or `-f jsonl`, stdout holds one record,
`{"device":"laptop","origin":"http://mimir.example.ts.net:64647","host_version":"0.26.0"}`.
The command never prints the device token.

- **The URL.** Only its origin is used. In a terminal, omit it to be asked.
  Elsewhere, a missing URL is a usage error.
- **`--device <name>`.** The name this machine pairs as, sent as given. Without
  it, the name is the first label of the hostname, lowercased: `Laptop.local`
  pairs as `laptop`.
- **The wait.** The CLI polls at the interval the host states, held between 1
  and 60 seconds. While the host answers, only its own `denied` and `expired`
  end the wait; the CLI's clock plays no part, so a clock that is off does not
  end it early. The expiry the CLI shows is the host's stated time left,
  counted from when the request was filed. A poll that cannot reach the host is
  noted once on stderr, and the wait goes on until that time passes. A denied or
  expired request, a definite error, and Ctrl-C end the run without writing
  anything. Ctrl-C also stops a poll in flight. A poll that returns the
  approval is always saved, even if Ctrl-C landed while it was in flight.
- **A lost approval.** Collecting the token revokes the device's earlier one on
  the host. When a poll fails and the next answer is `expired`, the approval may
  have been collected before the connection failed. The CLI then says so and
  asks you to run `mimir-host unpair <device>` on the host and pair again.
- **A config it cannot edit.** A `config.toml` that is not valid TOML, or that
  holds `host` as an inline table or dotted key, refuses before the request is
  filed, so no approval is wasted.
- **What it writes.** After approval, `credentials.toml` (mode `0600`) and then
  `[host] url` in `config.toml`. The edit keeps comments and other settings.
- **Pairing again.** The same origin replaces both files and rotates the token,
  with no question. A different origin asks "Replace the pairing with
  `<origin>`?" in a terminal, before it files a request. `--yes`, `--no-input`,
  or a run outside a terminal skip the question and warn on stderr that the
  device stays paired on the old host until `mimir-host unpair <device>` runs
  there. Both name the device the old host knows, from the recorded
  credentials.
- **`--no-input`.** Asks no questions, so a script never blocks. `-y` or
  `--yes` answers the replacement question.
- **A local store.** A `config.toml` with `[store]` makes `mimir pair` refuse and
  write nothing. Pairing would leave that board behind. Export it with
  `mimir store export board.json`, import it on the host as described in
  [Back up the store](#back-up-the-store) with `mimir-host store import - --apply`,
  remove `[store]` from `config.toml`, and run `mimir pair` again. The command
  never removes `[store]` itself.

The CLI checks `/health` and its version window before it files a request, and
refuses with the remedy (update this CLI, or update the host first) when it is
outside.

### Pair devices from the console

The console approves and unpairs devices without a shell on the host.

1. Open `/pair` in the console. A `?code=` in the URL, as `mimir pair` prints it,
   fills the code in.
2. Check that the code matches the one the device's terminal shows. The page
   then shows the device name, when the request was filed, and when it expires.
   A code that is wrong, already used, or expired gets one message: "No waiting
   request has this code."
3. Select **Approve** or **Deny**. When the device is already paired, the page
   warns that approving replaces its token. After approval, the device finishes
   pairing on its next poll.

`/devices` lists the requests that are waiting and the devices that are paired,
with when each was last used. A request's code is stored hashed, so the list
cannot show it. Decide on `/pair` with the code the device displays. Select
**Unpair** on a paired device and confirm to revoke its token at once. The
device must pair again to regain access.

## Administer the host with mimir-host

The image carries `mimir-host`, the operator CLI. Run it inside the
container:

```sh
docker compose -f deploy/compose.yaml exec mimir mimir-host <command>
```

It reads the host's configuration and opens the host's store. It never
creates or migrates the store, because the host migrates it on boot. A missing
store, or a schema other than the image's, is refused and left unchanged.

| Command | Effect |
| --- | --- |
| `pending` | Lists the live pairing requests: device, age, and expiry. |
| `approve <code>` | Approves the request whose device shows `<code>`. Notes when the device's current token will be replaced. |
| `deny <code>` | Denies the request, or withdraws an approval the device has not collected. |
| `unpair <device>` | Revokes the device's token, keeps its row, and discards its requests. |
| `tokens [--all]` | Lists user, device, created, last used, and revoked. `--all` adds revoked tokens. |
| `doctor [-s KEY]` | Reports the record-health findings that the console shows. Exits 0 after a scan. |
| `store export <file\|->` | Writes the transfer document. Refuses to overwrite a file. |
| `store import <file\|-> [--apply] [--resume]` | Reads a transfer document. A preview unless `--apply`. |

Codes are stored hashed, so `pending` cannot show them: read the code from the
device. Listings print a table on a terminal and JSON when piped, and `-f`
picks a format. `docker compose exec` gives the command a terminal, so pass
`-T` or `-f json` when you pipe its output. `mimir-host` has no `store upgrade`.

## Read an error from the Engine endpoint

A refused `/trpc` call carries the Mimir error under
`error.json.data.mimirError`, with its `code`, `message`, and optional `hint`.
An internal failure sets `mimirError` to `null`, so a client checks for it
before reading the code. The code maps to an HTTP status:

| code         | HTTP status |
| ------------ | ----------- |
| `validation` | 400         |
| `not_found`  | 404         |
| `conflict`   | 409         |
| `invariant`  | 500         |
| `internal`   | 500         |

A missing, malformed, unknown, revoked, or rotated bearer token returns `401`,
with `error.json.message` set to `unauthorized`, `error.json.data.code` set to
`UNAUTHORIZED`, and `mimirError: null`.

`invariant` is the broken-store signal: the store raises it when its own
consistency guarantees fail, such as a missing schema or one that does not match
the host. The message says what failed and the remedy line says what to do.
`conflict` is an ordinary state clash, such as a duplicate key or a write
refused because the state already moved. Adjust the request instead of
repairing the store. A `400` is an ordinary refusal of a malformed request.
`internal` carries `mimirError: null`: the response says only `the request did
not complete` and hints `run 'mimir doctor'`, and the host log carries the detail.

## Upgrade the host and the CLIs that share its Postgres

Each image version matches a CLI release. `next` follows the newest
prerelease, and `latest` follows the newest official release. For a
deployment, pin a version in `deploy/.env`, which Compose reads and Git
ignores:

```sh
MIMIR_VERSION=0.26.0
```

To pin the exact build, append its digest:
`MIMIR_VERSION=0.26.0@sha256:<digest>`.

CLIs that open the same Postgres directly
([Postgres store](postgres-store.md)) need an order. To upgrade, update the
host first:

1. Set the new `MIMIR_VERSION`, then pull and restart:

   ```sh
   docker compose -f deploy/compose.yaml -f deploy/compose.postgres.yaml pull mimir
   docker compose -f deploy/compose.yaml -f deploy/compose.postgres.yaml up -d --wait
   ```

   The host applies the release's migrations before it serves. Its log lists
   each one.

2. Update every CLI that shares the database with `mimir self-update`.

A CLI older than the schema refuses the store until you update it. You do not
need `mimir store upgrade`: the host already ran the migrations. The host
never downgrades. An image older than the schema refuses startup and asks you
to update the image.

## Back up the store

Export the store from the host with `mimir-host`, on either backend. `-T`
keeps the transfer document's bytes off a terminal. The shell creates the
output file before the export runs, so write to a partial file and give it a
new name only when the export succeeds. An earlier backup is never truncated:

```sh
docker compose -f deploy/compose.yaml exec -T mimir mimir-host store export - > board.json.partial \
  && mv board.json.partial "board-$(date +%Y%m%d-%H%M%S).json"
```

The export is one backend-neutral document with ids, sequences, and
timestamps intact. It carries no device tokens, so devices pair again with a
new host. To restore it, start a host on an empty store, preview the import,
and then apply it:

```sh
docker compose -f deploy/compose.yaml exec -T mimir mimir-host store import - < board-20261020-120000.json
docker compose -f deploy/compose.yaml exec -T mimir mimir-host store import - --apply < board-20261020-120000.json
```

A SQLite store can also back up as a copy of its volume, which keeps the
device tokens. Stop the host so the database is closed, copy the volume, and
start the host again:

```sh
docker compose -f deploy/compose.yaml stop mimir
docker run --rm -v mimir_data:/data:ro -v "$PWD":/backup alpine tar -czf /backup/mimir-data.tgz -C /data .
docker compose -f deploy/compose.yaml start mimir
```

Do not copy `store.sqlite` while the host runs. To restore, stop the host,
extract the archive into the volume, and start the host:

```sh
docker compose -f deploy/compose.yaml stop mimir
docker run --rm -v mimir_data:/data -v "$PWD":/backup alpine sh -c 'rm -f /data/store.sqlite* && tar -xzf /backup/mimir-data.tgz -C /data && chown -R 1000:1000 /data'
docker compose -f deploy/compose.yaml start mimir
```

## Source

`deploy/compose.yaml` and `deploy/compose.postgres.yaml` (the examples),
`Dockerfile` (the image, its `/data` volume, and its health check),
`packages/host/src/server/config.ts` (the variables),
`packages/host/src/server/host.ts` (store open and migration),
`packages/host/src/server/lifecycle.ts` (the guards and startup refusal),
`packages/host/src/server/guard.ts` (the Host allowlist and the cross-origin write
check), `packages/host/src/server/pairing.ts` (the pairing routes and their limit),
`packages/core/src/tokens.ts` (pairing requests and device tokens),
`packages/host/src/admin/` (`mimir-host`),
`packages/wire/src/server.ts` (the `/trpc` error mapping),
`packages/host/src/start-routes/health.ts` (`/health`).
