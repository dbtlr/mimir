---
description: "Reference for network modes, installation-bound port selection, the listening address, the console URL, and accepted hosts."
---

# Network modes and port

`mimir serve` speaks plain HTTP and authenticates no one. It listens on
loopback by default, so a fresh install reaches the console from its own
machine with no configuration. Reaching it from another device is a choice
among four network modes:

| Mode                                     | Mimir configuration           | HTTPS and PWA                             | Who can reach the console        |
| ---------------------------------------- | ----------------------------- | ----------------------------------------- | -------------------------------- |
| [Local only](#local-only) (default)      | none                          | yes: `localhost` is a secure context      | this machine                     |
| [Tailscale serve](#tailscale-serve)      | none                          | yes: a `ts.net` certificate               | devices on the tailnet           |
| [Direct network](#direct-network)        | `[serve] bind`                | no: plain HTTP, no PWA install or offline | anyone who can reach the address |
| [Reverse proxy](#reverse-proxy)          | optional `url` and `hosts`    | yes, at the proxy                         | whoever the proxy lets through   |

`tailscale serve` is the recommended way to reach the console from another
device. In every mode, `serve` refuses browser writes from another origin.
Setting [`[serve] hosts`](#accepted-hosts) adds a Host check to any mode.
Authentication is outside the binary
([ADR 0012](../decisions/0012-http-api-true-resource-envelope.md)): a tailnet
or a proxy provides it, or nothing does.

Restart the service after changing any `[serve]` key: `serve` reads them at
start.

## Local only

This is the default. Run `mimir serve` and open the address it prints, such as
`http://127.0.0.1:64647/`. Browsers treat loopback as a secure context, so the
console installs as a PWA and keeps its offline reads.

## Tailscale serve

Keep the loopback bind and let Tailscale proxy your tailnet's HTTPS name to it.
Use the port your install listens on:

```sh
tailscale serve --bg 64647
```

The console is then at `https://<machine>.<tailnet>.ts.net/`, for devices on
the tailnet only. The tailnet needs MagicDNS and HTTPS certificates turned on.
Tailscale terminates TLS with a `ts.net` certificate, so the PWA installs and
works offline. Its proxy keeps the browser's `Host` header, so console writes
pass the cross-origin check. `--bg` keeps the proxy running after the command
exits; `tailscale serve reset` removes it.

To have Mimir print the tailnet address instead of loopback, set `url`:

```toml
[serve]
url = "https://box.tail1234.ts.net"
```

`tailscale funnel` publishes a port to the internet, not the tailnet. Do not
use it for Mimir: the board would be open to anyone.

## Direct network

Set `[serve] bind` to listen on a network address:

```toml
[serve]
bind = "0.0.0.0"
```

The console is then at `http://<address>:<port>/` for anyone who can reach
that address, with no authentication: they can read and write the board.
Plain HTTP on an address other than loopback is not a secure context, so the
console works as a page but does not install as a PWA or keep offline reads.

To keep the board off the LAN, bind one address instead of every interface,
such as the machine's tailnet address (`bind = "100.64.0.7"`).

## Reverse proxy

Keep the loopback bind and put a proxy that terminates TLS in front, such as
Caddy:

```caddyfile
mimir.example.local {
	reverse_proxy 127.0.0.1:64647
}
```

The proxy owns TLS and any authentication. It must forward the browser's
`Host` header, which Caddy does by default; a proxy that rewrites `Host` to the
upstream address makes `serve` refuse console writes. A proxy on another
machine needs `serve` to [bind](#listening-address) an address it can reach.

Both Mimir keys are optional. `url` makes Mimir print the proxy's name, and
`hosts` turns on the Host check, which then answers `url`'s host too:

```toml
[serve]
url = "https://mimir.example.local"
hosts = []
```

## Listening address

`mimir serve` listens on `127.0.0.1` unless `[serve] bind` names another IP
address. `0.0.0.0` or `::` listens on every interface; a specific address
listens there only. An address that is not on this machine stops `serve` with
an error that names it. An invalid `bind` is ignored with a warning, and
`serve` listens on loopback. A zone-scoped link-local address, such as
`fe80::1%en0`, is invalid: no URL can carry its zone.

With `0.0.0.0` or `::`, `serve` also checks the loopback address on its port.
If another program holds it there, `serve` treats the port as taken, because
the health check and the printed console address would reach that program.
Health checks reach a specific non-loopback bind at that address, and every
other bind at loopback.

## Console URL

`[serve] url` is the console's public `http` or `https` origin, such as the
name a proxy or Tailscale serves. `serve` prints it at startup, and
`service install` and `service status` show it as the console address. It
does not turn on the Host check; when `hosts` is set, its host is answered too.
An invalid `url`, including one with a path, query, or credentials, is ignored
with a warning.

## Accepted hosts

By default `mimir serve` answers any `Host`, so every name the install is
reached by (an IP address, a MagicDNS name, a proxy hostname) works without
configuration.

The Host check is optional hardening against DNS rebinding. Binding loopback
does not stop it: a web page whose domain resolves to `127.0.0.1` is
same-origin with the daemon. That page still sends its own name as the `Host`
header, so when `[serve] hosts` is set, `mimir serve` answers only these hosts
and refuses every other one with a 403 before any route runs:

- the loopback names `localhost`, `127.0.0.1`, and `[::1]`, on any port;
- each hostname in `[serve] hosts` in the installation configuration;
- the `[serve] bind` address, when it names one address rather than a wildcard;
- the host of `[serve] url`, when it is set.

Every console address `serve` prints is one of these names.

Hostnames match without regard to case or port. List every name you reach the
console by; a reverse proxy usually forwards the client's `Host` (Caddy does
by default), so that includes the proxy's public name:

```toml
[serve]
hosts = ["mimir.example.local"]
```

`hosts = []` answers the loopback names only. Each entry is a bare hostname
(letters, digits, `.`, `-`, `_`) or a bracketed IPv6 literal, with no port and
no wildcards. An invalid `hosts` value fails closed: `serve` warns and answers
the loopback names only, and the port still applies. A `[serve]` section that
is not a table, such as `[[serve]]`, fails closed the same way. The `serve` log
names each refused hostname once, for up to 64 names.

`X-Forwarded-Host` is never consulted: a same-origin page can set it.

Whatever `hosts` says, `serve` refuses a browser write from another origin: a
request with any method but `GET` or `HEAD` whose `Origin` does not match its
`Host`, or whose `Sec-Fetch-Site` is neither `same-origin` nor `none`. This
needs no configuration as long as any proxy in front keeps the browser's
`Host` header. It stops other sites and other local web apps, but not a
rebinding page: that page is same-origin by construction, so without `hosts`
it can read and write the board. Set `hosts` when the machine that runs the
console's browser also browses untrusted sites.

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

## Source

`packages/bin/src/main.ts` (`serve` command wiring, precedence),
`packages/bin/src/env.ts` (`MIMIR_PORT` parsing),
`packages/bin/src/service/config.ts` (`[serve]` config read/write),
`packages/bin/src/service/address.ts` (`bind` and `url` handling),
`packages/bin/src/http/host.ts` (the accepted-host guard and the cross-origin
write check),
`packages/bin/src/service/plist.ts` (the generated unit — no `--port`).
