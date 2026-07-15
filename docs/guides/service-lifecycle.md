# Service lifecycle

`mimir service` supervises two launchd units: `serve` (the daemon, installed
by default) and `snapshot` (the vault commit timer, opt-in — pass `snapshot`
or `all` to `install` explicitly). Both are managed through
`packages/bin/src/service/launchd.ts`.

## The verbs

- **`install [unit]`** — writes the plist(s) to `~/Library/LaunchAgents/` and
  loads them (`launchctl bootstrap`). A bare `install` sets up `serve` only.
- **`start` / `restart`** — `start` bootstraps an installed-but-unloaded unit;
  `restart` is `launchctl kickstart -k`, a live in-place restart.
- **`stop`** — `launchctl bootout`. This is a real, durable stop: the plist
  stays on disk, but the unit is unloaded and stays unloaded. There is no
  KeepAlive respawn to fight — `bootout` removes the unit from launchd
  entirely rather than merely killing the process it's supervising.
- **`uninstall [unit]`** — everything `stop` does, plus it deletes the plist
  file. A bare `uninstall` tears down whatever is actually installed; it never
  orphans the opt-in `snapshot` timer (which would otherwise keep
  auto-committing/pushing the vault unattended).
- **`status`** — read-only over every unit; never mutates, and works even
  from an untrusted build (see below).

So: `stop` if you want the unit gone until you explicitly start it again but
might reinstall soon; `uninstall` if you're removing mimir's footprint from
launchd for good.

## The bootout/bootstrap race

`bootout` is asynchronous — it returns before launchd has fully torn the unit
down. An `install` or `start` that follows immediately (including internally,
during `install`'s own bootout-then-bootstrap sequence) can lose that race and
see `bootstrap` fail with exit code 5 ("Input/output error"). This is handled
for you: `bootstrapWithRetry` retries the bootstrap a few times, waiting
between attempts, but **only** on exit code 5 — any other nonzero exit is a
genuine failure and surfaces immediately, uncaught. You don't need a retry
loop of your own around `service install` or `service start`.

## The dev-build fence

Every mutating verb (`install`, `uninstall`, `start`, `stop`, `restart`)
refuses to touch the real launchd unless the running binary is a trusted
production build, or `MIMIR_ALLOW_REAL_SERVICE=1` is set. This exists so a
`bun run` dev invocation or a smoke test can never silently pollute
`~/Library/LaunchAgents`. `status` is exempt — it only reads.

## Source

`packages/bin/src/service/launchd.ts` (the supervisor), `commands.ts` (the
verb layer), `plist.ts` (the generated unit XML).
