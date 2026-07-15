# Port and proxy posture

## Port precedence

`mimir serve` resolves its port in this order, highest wins:

1. `--port <n>` flag
2. `MIMIR_PORT` environment variable
3. `[serve] port` in `~/.config/mimir/config.toml` (`$XDG_CONFIG_HOME` if set)
4. the built-in default

A malformed `MIMIR_PORT` (not an integer in 1–65535) is ignored with a
warning, not a hard failure. `service install --port <n>` writes the config
file's `[serve] port` — it does not set an env var and does not touch the
plist.

## The plist never bakes a port

The launchd unit's `ProgramArguments` for `serve` are always just
`serve --no-hunt` — no `--port`. The daemon reads its port from the config
file (or `MIMIR_PORT`, if you've set that in the plist's own
`EnvironmentVariables`, which install does not do for you) at process start.
This means retargeting the port is edit-config-then-restart, never a plist
rewrite: `mimir service install --port <n>` followed by
`mimir service restart` (or just `install` again, which reinstalls the unit).

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
