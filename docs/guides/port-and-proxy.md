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

The launchd unit's `ProgramArguments` for `serve` are always just
`serve --no-hunt` — no `--port`. The daemon reads its port from the config
file (or `MIMIR_PORT`, if you've set that in the plist's own
`EnvironmentVariables`, which install does not do for you) at process start.
This means retargeting the port is edit-config-then-restart, never a plist
rewrite: `mimir service install --port <n>` followed by
`mimir service restart` (or just `install` again, which reinstalls the unit).

Only registered live installations can install or manage the host service.
There is no environment override that grants this authority to a development binary.

## Loopback only — the proxy is the boundary

`mimir serve` binds `127.0.0.1` hard-coded; there is no `--host` flag and no
plan to add one. TLS, hostnames, and any exposure beyond localhost are
deliberately left to a reverse proxy in front (Caddy, in the reference setup)
per [ADR 0012](../decisions/0012-http-api-true-resource-envelope.md).
Nothing in mimir itself terminates TLS or authenticates non-localhost
traffic — if you need mimir reachable from another host, that's a proxy
config, not a mimir flag.

## Source

`packages/bin/src/main.ts` (`serve` command wiring, precedence),
`packages/bin/src/env.ts` (`MIMIR_PORT` parsing),
`packages/bin/src/service/config.ts` (`[serve] port` config read/write),
`packages/bin/src/service/plist.ts` (the generated unit — no `--port`).
