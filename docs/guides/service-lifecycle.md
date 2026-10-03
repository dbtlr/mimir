---
description: "Reference for service lifecycle commands on launchd and systemd, and the supervisor fence."
---

# Service lifecycle

`mimir service` supervises two units: `serve` (the daemon, installed by
default) and `snapshot` (the vault commit timer, opt-in — pass `snapshot` or
`all` to `install` explicitly). On macOS the units are launchd agents. On Linux
they are systemd user units. The verbs, the fence, and the output are the same
on both platforms.

## The verbs

- **`install [unit]`** — writes the unit file(s) and loads them. A bare
  `install` sets up `serve` only. Re-running `install` refreshes the units in
  place.
- **`start` / `restart`** — `start` loads an installed-but-stopped unit;
  `restart` is a live in-place restart.
- **`stop`** — a real stop: the unit stays installed but is not running, and
  the supervisor does not respawn it. It comes back at the next login (launchd)
  or the next start of the user manager (systemd).
- **`uninstall [unit]`** — everything `stop` does, plus it deletes the unit
  files. A bare `uninstall` tears down whatever is actually installed; it never
  orphans the opt-in `snapshot` timer (which would otherwise keep
  auto-committing/pushing the vault unattended).
- **`status`** — read-only over every unit; never mutates, and works even
  from an untrusted build (see below).

So: `stop` if you want the unit gone until you explicitly start it again but
might reinstall soon; `uninstall` if you're removing mimir's footprint from
the supervisor for good.

Both supervisors restart a `serve` process that exits or is killed. A port held
by another process makes `serve --no-hunt` fail loudly; the supervisor retries
about every 10 seconds until the port is free.

## macOS: launchd

The units are `com.dbtlr.mimir.serve` (KeepAlive, RunAtLoad) and
`com.dbtlr.mimir.snapshot` (StartInterval), loaded into the `gui/<uid>` domain.
A live installation writes their plists to `~/Library/LaunchAgents/`.

| Verb        | launchctl                         |
| ----------- | --------------------------------- |
| `install`   | `bootout`, then `bootstrap`       |
| `start`     | `bootstrap`                       |
| `stop`      | `bootout` (the plist stays)       |
| `restart`   | `kickstart -k`                    |
| `uninstall` | `bootout`, then delete the plist  |
| `status`    | `print` (nonzero means not loaded) |

### The bootout/bootstrap race

`bootout` is asynchronous — it returns before launchd has fully torn the unit
down. An `install` or `start` that follows immediately (including internally,
during `install`'s own bootout-then-bootstrap sequence) can lose that race and
see `bootstrap` fail with exit code 5 ("Input/output error"). This is handled
for you: `bootstrapWithRetry` retries the bootstrap a few times, waiting
between attempts, but **only** on exit code 5 — any other nonzero exit is a
genuine failure and surfaces immediately, uncaught. You don't need a retry
loop of your own around `service install` or `service start`.

## Linux: systemd user units

The units run in your `systemd --user` manager:

- `com.dbtlr.mimir.serve.service` — `Restart=always` with `RestartSec=10` and
  no start limit, `WantedBy=default.target`.
- `com.dbtlr.mimir.snapshot.timer` — fires every interval after it is armed and
  after each run, activating `com.dbtlr.mimir.snapshot.service`, a
  `Type=oneshot` unit that runs `vault snapshot` and exits. Only the timer is
  enabled.

A live installation writes these files to `~/.config/systemd/user/`. Logs go to
the same files as on macOS (`serve.log` and `snapshot.log` under the
installation's data directory), not to the journal.

| Verb        | `systemctl --user`                                      |
| ----------- | ------------------------------------------------------- |
| `install`   | `link` (snapshot's oneshot service), `enable <file>`, `daemon-reload`, `restart` |
| `start`     | `start`                                                 |
| `stop`      | `stop` (the unit stays enabled)                         |
| `restart`   | `restart`                                               |
| `uninstall` | `stop` (each running unit), `disable`, delete the unit files, `daemon-reload` |
| `status`    | `show` (loaded means active, activating, deactivating, or reloading) |

For `snapshot`, `restart` re-arms the timer; it does not run a snapshot
immediately.

### Run without a login session

A user manager normally exists only while you are logged in. On a headless
host, enable linger once so the manager, and the enabled units, start at boot:

```sh
sudo loginctl enable-linger "$USER"
```

`systemctl --user` needs `XDG_RUNTIME_DIR` (normally `/run/user/<uid>`) to
reach the manager. A login shell sets it. In a non-login context such as `sudo
-u` or a CI job, export `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` before running
`mimir service`.

### Move a bare `mimir serve` onto the service

A host that runs `mimir serve` directly, outside any supervisor:

1. On a Norn-backend installation, check that `command -v norn` prints a path.
   `service install` requires `norn` on `PATH` and a vault there, and stops
   before it writes a unit if either is missing. Check first so the daemon is
   not left down. The SQLite and PostgreSQL backends need neither.
2. Stop the bare process.
3. Run `mimir service install` (add `--port <n>` to persist a port).
4. Run `mimir service status` and check that `serve` is running and
   `/api/health` answers.

## The supervisor fence

Every mutating verb (`install`, `uninstall`, `start`, `stop`, `restart`)
requires a registered installation, and it drives only that installation's own
units. A build profile or environment variable cannot grant access to the host
supervisor. `status` remains read-only.

- A **live installation** owns the names above.
- A **sandbox installation** owns `com.dbtlr.mimir.sandbox-<id>.serve` and
  `com.dbtlr.mimir.sandbox-<id>.snapshot`, derived from its sandbox identifier.
  It keeps its unit files in its own data directory and cannot address the live
  units or another sandbox's.
- A **source run or unregistered binary** mutates no unit.

Self-update restarts the daemon only when the same check allows it; otherwise
it reports that the restart was skipped.

The installer binds the executable path and hash to its configuration, data,
and cache directories. Source runs and unregistered binaries use isolated
`.dev` directories. Registered sandboxes use their own bound directories.
Configuration commands follow the same paths. Logs remain under the bound
data directory.

Live units read their port from the installation configuration. The installer
resolves XDG directories once, so later environment changes do not redirect an
existing installation. A sandbox unit bakes its resolved port into the unit.

## Verify the lifecycle

`bun run sandbox service-verify` checks the real supervisor without touching the
live units. See [Development sandboxes](development-sandboxes.md#verify-the-service-lifecycle).

## Source

`packages/bin/src/service/`: `launchd.ts` and `systemd.ts` (the supervisors),
`plist.ts` and `systemd-unit.ts` (the generated unit files), `units.ts` (unit
names and the fence), and `commands.ts` (the verb layer).
