---
description: Run the Mimir host container on Docker Desktop or a server, reach it safely, check its health, upgrade it, and back up its store.
---

# Run the Mimir host

The host image, `ghcr.io/dbtlr/mimir-host`, carries the console, the Engine
endpoint at `/trpc`, and the store
([ADR 0035](../decisions/0035-tanstack-start-container-host.md)). It reads its
configuration from environment variables, migrates its store before it serves,
and needs no CLI installation. `deploy/compose.yaml` runs it over SQLite, and
`deploy/compose.postgres.yaml` layers Postgres on top.

## Keep the console on a single-user tailnet

The host authenticates no one. Any client that reaches its port can read and
write the whole board through the console or `/trpc`. The Host
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

`GET /health` returns `{"schema":5,"status":"ok","version":"0.26.0"}` and
never reads the store. The host answers no request until its store has opened
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
input, so pass the input as a query parameter:

```sh
curl --fail --silent --show-error --get http://127.0.0.1:64647/trpc/projects \
  --data-urlencode 'input={"json":{}}'
```

A healthy host answers `200` with a body that starts `{"result":{"data":{"json":[`,
followed by the project list. A store the host cannot read answers `500`, which
`--fail` turns into a non-zero exit. The console's Record health page shows the
findings that `mimir doctor` reports.

The retired `/api` answers every method with `410` and a JSON body whose error
code is `gone` and whose hint names `/trpc`, so a stale probe such as
`curl --fail .../api/projects` fails instead of passing on the console's HTML.
Besides that tombstone, the host serves `/health`, `/trpc`, the console's
server functions under `/_serverFn`, and the console itself. The host guard
covers every one of them.

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

On Postgres, export from a CLI that opens the same database:

```sh
mimir store export board.json
```

The export is one backend-neutral document with ids, sequences, and
timestamps intact. To restore it into an empty database, follow
[Back up](postgres-store.md#back-up). Then start the host on that database.

The image has no `mimir` CLI, so a SQLite store backs up as a copy of its
volume. Stop the host so the database is closed, copy the volume, and start
the host again:

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
check), `packages/wire/src/server.ts` (the `/trpc` error mapping),
`packages/host/src/start-routes/health.ts` (`/health`).
