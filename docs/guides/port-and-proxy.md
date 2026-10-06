---
description: "Reference for installation-bound port selection and loopback proxy behavior."
---

# Port and proxy posture

## Port precedence

An installed production `mimir serve` resolves its port in this order, highest
wins:

1. `--port <n>` flag
2. `MIMIR_PORT` environment variable
3. `[serve] port` in the installation configuration
4. the built-in default

Source runs and unregistered binaries read only their isolated `.dev`
configuration. Registered sandboxes read their bound configuration. Their
default port is `64747`; live installations default to `64647`.

A malformed `MIMIR_PORT` is ignored with a warning. For a live installation,
`service install --port <n>` writes `[serve] port` in its bound configuration.
It does not change the plist. `setup` uses the same installation-bound path.

## Production plists do not bake a port

The live `serve` unit (launchd `ProgramArguments`, systemd `ExecStart`) always
runs just `serve --no-hunt` — no `--port`. The daemon reads its port from the config
file (or `MIMIR_PORT`, if you've set that in the plist's own
`EnvironmentVariables`, which install does not do for you) at process start.
This means retargeting the port is edit-config-then-restart, never a plist
rewrite: `mimir service install --port <n>` followed by
`mimir service restart` (or just `install` again, which reinstalls the unit).

Only a registered installation can install or manage a host service, and only
its own units. There is no environment override that grants this authority to a development binary.

## Loopback only — the proxy is the boundary

`mimir serve` binds `127.0.0.1` hard-coded; there is no `--host` flag and no
plan to add one. TLS, hostnames, and any exposure beyond localhost are
deliberately left to a reverse proxy in front (Caddy, in the reference setup)
per [ADR 0012](../decisions/0012-http-api-true-resource-envelope.md).
Nothing in mimir itself terminates TLS or authenticates non-localhost
traffic — if you need mimir reachable from another host, that's a proxy
config, not a mimir flag.

## Accepted hosts

Binding loopback does not stop DNS rebinding: a web page whose domain resolves
to `127.0.0.1` is same-origin with the daemon. That page still sends its own
name as the `Host` header, so `mimir serve` answers only these hosts and
refuses every other one with a 403 before any route runs:

- the loopback names `localhost`, `127.0.0.1`, and `[::1]`, on any port;
- each hostname in `[serve] hosts` in the installation configuration.

Hostnames match without regard to case or port. A reverse proxy usually
forwards the client's `Host` (Caddy does by default), so list the proxy's
public name:

```toml
[serve]
hosts = ["mimir.example.local"]
```

Each entry is a bare hostname (letters, digits, `.`, `-`, `_`) or a bracketed
IPv6 literal, with no port and no wildcards. An invalid `hosts` value is
ignored with a warning and the port still applies. `serve` reads the list at
start, so restart the service after a change. The `serve` log names each
refused hostname once, for up to 64 names.

`X-Forwarded-Host` is never consulted: a same-origin page can set it.

## Source

`packages/bin/src/main.ts` (`serve` command wiring, precedence),
`packages/bin/src/env.ts` (`MIMIR_PORT` parsing),
`packages/bin/src/service/config.ts` (`[serve]` config read/write),
`packages/bin/src/http/host.ts` (the accepted-host guard),
`packages/bin/src/service/plist.ts` (the generated unit — no `--port`).
