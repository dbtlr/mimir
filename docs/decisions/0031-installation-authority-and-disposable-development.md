---
title: 'ADR 0031: Installation authority and disposable development'
description: Bind live-store authority to installed executables and reproduce development against owned Postgres sandboxes and native snapshots.
status: accepted
date: 2026-09-17
---

# ADR 0031: Installation authority and disposable development

## Context

The Postgres bridge in [ADR 0030](0030-postgres-store-backend-shared-store-bridge.md)
makes the per-install configuration select a shared database. A production build
profile currently grants access to that configuration, even when the executable
has only been built in a checkout. Real-server tests also accept a caller-supplied
database URL and create temporary schemas on that server. Neither boundary proves
that development stays off the live database.

Development needs the real installation and migration paths, with repeatable
fixtures and optional restored snapshots. Manual container commands and agent
instructions cannot be the enforcement mechanism.

## Decision

### Installation owns authority

An installation receipt binds a canonical executable path and SHA-256 digest to
resolved Mimir configuration, data, and cache directories. Its mode is live or
sandbox. The installer writes the receipt. Building or downloading a binary does
not register it. The runtime checks the receipt before accessing its bound state.
An update validates the previous installation, preserves its bindings, and records
the replacement digest. A missing receipt uses isolated development defaults; an
invalid or mismatched receipt fails closed. Neither case falls back to live paths.

The normal installer resolves the XDG roots once. The receipt records Mimir's
directories, not a process-wide change to XDG variables. Ambient variables cannot
redirect a registered installation. A sandbox installation uses the same installation
mechanism but binds to directories owned by its sandbox.

This prevents accidental access through supported execution paths. It is not an
OS security boundary against modified code running as the credential owner's user.
No development override grants live access. Only a registered live executable may
connect to the configured live store.

### Development owns disposable resources

A repository-local TypeScript CLI, run with pinned Bun and built with a pinned
published Loom package, owns provisioning, installation, fixtures, restoration,
upgrades, verification, and cleanup. It is development tooling, outside the shipped
Mimir CLI. This refines the distribution boundary of
[ADR 0010](0010-one-binary-transport-only-consumption.md): product consumption remains
through the installed binary; development orchestration is a repository tool.

The tool creates a dedicated Postgres container, random credentials, a loopback
endpoint, and isolated configuration and state directories. An authority file binds
that endpoint to the sandbox. A connection must match this generated authority;
the tool and test suite do not accept arbitrary database URLs. Copying live
configuration into a sandbox does not grant authority to its database.

Automatic test runs create and destroy their resources. Interactive sandboxes remain
until explicitly removed. Resource identifiers and ownership labels govern cleanup;
cleanup never targets an arbitrary supplied container or directory. A failed run
records its outcome and retained resources so scripted cleanup can finish later.

### Rehearsal restores a snapshot, never production connectivity

Synthetic fixtures are the default. A realistic rehearsal reads a separately
produced snapshot from a configured local directory. No sandbox command exports
from, connects to, or obtains credentials for the live database. Scheduling and
publishing production backups are separate work.

The interchange format is a PostgreSQL `pg_dump --format=custom` archive containing
the complete application database schema, data, and migration state. A versioned
JSON sidecar records snapshot identity, capture time, PostgreSQL server version,
dump-tool version, and archive SHA-256. Standard `pg_restore` can restore the archive
without Mimir. It is not the backend-neutral Mimir Store export format.

The producer publishes a complete snapshot directory atomically. The consumer
selects an explicit snapshot identity; `latest` resolves once to a recorded identity
and digest. The archive is verified before restoration. Restore uses a fresh
database, sandbox ownership, and no source ACLs. Supported server and tool versions
are checked before use. Restored data remains sensitive and is never committed.

A restore does not migrate first. A rehearsal restores the previous schema, installs
the candidate in the sandbox, runs the real `store upgrade`, and verifies the result.
An older baseline binary can exercise the previous installation before replacement.
Snapshots newer than the candidate's supported schema are refused, not downgraded.

### Commands are the reproducibility contract

Each workflow has one command with limited inputs: create, restore, verify, upgrade,
rehearse, test, and destroy. Command handlers validate inputs; independently testable
orchestration functions perform the work. They invoke subprocesses with argument
arrays, bounded waits, explicit environments, and checked exit status.

Run records identify the candidate digest, container image digest, fixture revision
or snapshot identity and checksum, operations, and outcomes. Reproduction means
replaying those inputs and checks; random resource identifiers and execution times
are recorded rather than claimed to be byte-identical. A failure must never report
success because verification was skipped.

## Delivery and acceptance

1. Upgrade the workspace Bun pin to a Loom-supported version. Verify the existing
   code in isolation before adding Loom-based tooling.
2. Implement installation receipts and the connection boundary. Test source runs,
   uninstalled builds, copied/replaced binaries, bound directories, and updates.
3. Implement owned containers, synthetic fixtures, verification, and cleanup. Replace
   the arbitrary-URL integration lane with the scripted disposable lane in CI.
4. Implement native snapshot restore and migration rehearsal. Exercise a real archive
   created from a disposable database, plus corrupt/incomplete/incompatible inputs.
5. Run independent architecture and failure-path reviews, resolve findings, and
   publish the verified change for human review. Deployment and live installation
   changes are outside this task.

The future snapshot directory is intentionally configurable and initially unset.
Fixture-only development works without it. The first implementation records the
precise sidecar schema and runnable command syntax in the development guide.

## Alternatives

- A build-time production flag does not distinguish a build from an installation.
- A production-access environment flag creates a persistent escape route.
- Temporary schemas on an arbitrary server still touch that server's database.
- OS credential brokering provides stronger isolation but exceeds the accidental-use
  boundary selected here.
- Bash-only orchestration makes manifest validation and recoverable lifecycle state
  harder to test. TypeScript uses the existing stack; Loom is a bounded framework
  trial that does not migrate the product CLI.

## References

- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [PostgreSQL pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)

## Refinement (2026-10-01, MMR-54): the supervisor fence is per installation

The supervisor fence was a single capability: only a live installation could
mutate the host supervisor, and every installation used the same unit names. That
kept development away from the live daemon, but it also meant the real supervisor
lifecycle could only be exercised against the live units. Adding systemd made that
gap unacceptable, because a second backend needs the same real-lifecycle proof.

The fence narrows instead of opening.

- **Unit names belong to an installation.** A live installation keeps
  `com.dbtlr.mimir.serve` and `com.dbtlr.mimir.snapshot` (launchd labels, and the
  same names as systemd units), so existing installations need no migration. A
  sandbox installation derives `com.dbtlr.mimir.sandbox-<id>.serve` and
  `com.dbtlr.mimir.sandbox-<id>.snapshot` from its authority's identifier, a UUID
  written in lowercase.
- **An installation drives only its own units.** A live installation may mutate
  only the live names. A sandbox installation may mutate only its own
  sandbox-scoped names, so it can never address the live daemon or another
  sandbox. A process without an installation still mutates nothing. Status
  remains a read. Self-update restarts the daemon only under the same check.
- **A sandbox may have no database.** A vault sandbox authority (`kind: "vault"`)
  binds owned directories and no Postgres endpoint; no database URL matches it.
  Its store is the Norn vault in its own data directory, so the lifecycle check
  runs on hosts without Docker, such as GitHub's macOS runners.
- **Lifecycle verification is a sandbox command.** `bun run sandbox
  service-verify` installs a vault sandbox under the host supervisor (launchd on
  macOS, systemd user units on Linux) and proves install, status, restart,
  kill-and-recover, stop, start, and uninstall through `/api/health` and the
  supervisor's own state. It records the live units' state before and after and
  fails if it changed. `--target container` runs systemd as PID 1 in a
  disposable container instead; there the release `install.sh` performs a live
  installation that belongs to the container, with its own empty configuration.
  A manually dispatched workflow runs the host check on both platforms. It never
  runs on push or pull request.

Unit files follow the supervisor's conventions. A live launchd plist stays in
`~/Library/LaunchAgents`, and a live systemd unit is placed in
`~/.config/systemd/user`. A sandbox keeps its unit files in its own data
directory: `launchctl bootstrap` accepts any path, and `systemctl --user enable`
links an out-of-path file into the manager.

## Refinement (2026-10-03, MMR-421): serve may open a named SQLite file

`mimir serve --store <file>` serves an existing SQLite file for that one run
instead of the installation's store. The docs fixture uses it: `bun run
fixtures:docs` writes `.dev/fixtures/docs.sqlite`, outside every installation's
data directory, so no installation opens the fixture unless a command names it.

This refines the boundary without opening it. The flag is per invocation and
never persists, unlike the environment flag this decision rejected. It does not
change which store an installation, its supervisor unit, or any other command
opens. Serve parses its flags strictly, so a misspelled flag fails instead of
falling back to the installation's store. The named file must already be a
Mimir store at exactly the binary's schema version: it is checked before
anything is written and never migrated, so a development build cannot upgrade a store past the binary
that owns it. A Postgres installation refuses the flag, because a file cannot
redirect a database endpoint. Naming a file is a deliberate act, and this
decision guards against accidental access.

## Refinement (2026-10-15, MMR-528): container configuration and authority

[ADR 0035](0035-tanstack-start-container-host.md) defines a separate authority
for the container host. It reads environment variables rather than an
installation's `config.toml`: `MIMIR_DATABASE_URL` or
`MIMIR_DATABASE_URL_FILE` selects Postgres, otherwise SQLite lives under
`MIMIR_DATA_DIR` (default `/data` in the image). `MIMIR_HOSTS`, `MIMIR_URL`,
and `MIMIR_PORT` configure the host's network settings. Setting both database
URL variables refuses startup and names both, with no precedence. Other
invalid values refuse startup and name the variable. The image's `/data`
default does not apply to a development host, whose SQLite store stays under
isolated `.dev` storage.

A host-authority constant set at image build permits the built image to open
a live Postgres URL. A development host has no such authority: environment
variables and secret files cannot grant it. It uses isolated SQLite or an
owned sandbox, whose Postgres endpoint must match its existing authority.
This is the same accidental-access boundary as the receipt system, not an
OS security boundary against modified code.

The host does not require an executable installation receipt. Existing CLI
executables still do, and their bound directories, store authority, and
supervisor fences remain unchanged until the tasks that retire those paths.
This refinement does not authorize a live cutover or remove `serve`.

## Changelog

- 2026-10-01: Scoped supervisor authority and unit names to each installation (MMR-54).
- 2026-10-03: Allowed a per-run existing SQLite file for serve without granting migration authority (MMR-421).
- 2026-10-15: Defined the container host's environment configuration and image authority (ADR 0035).
- 2026-10-17: Retired supervised units and the named serve store (MMR-536).
- 2026-10-19: Let Loom's installer record vouch for a script-installed binary, so its receipt is adopted or re-recorded with its bindings kept (MMR-554).
- 2026-10-29: Kept the install URL at the repository root, serving a copy of Loom's managed installer (MMR-603).

## Refinement (2026-10-17, MMR-536): no supervised units, no named store

The `mimir` binary no longer installs or drives supervisor units, so the
service lifecycle rules above, the sandbox `service-verify` command, and its
workflow are retired. Self-update replaces the binary and restarts nothing.

`mimir serve --store <file>` is retired with `serve`. The docs fixture is
generated into its own directory and opened by the development host through
`MIMIR_DATA_DIR`. The host migrates a store before serving it (ADR 0035), so the
fixture is regenerated rather than protected from migration. No installation's
command opens the fixture, which keeps the boundary this decision guards.

## Refinement (2026-10-19, MMR-554): Loom's installer record vouches for a binary

The Loom CLI installs through `loom init`'s managed `install.sh`
(`packages/cli/install.sh`) and replaces itself through Loom's self-update
plugin. Both record a script installation in Loom's installation record,
`install.json` in the platform state directory, as the binary's path and
SHA-256 digest. That record holds no install mode and no directories, and the
managed script runs no step of the installed binary (superseded by the MMR-555
refinement below: its `postInstall` runs `mcp install`), so Mimir keeps its own
receipt beside the binary until Loom's record can carry an application's
bindings (LM-s30).

The receipt stays the authority. Loom's record changes only how a receipt is
written:

- **A script installation is adopted on its first run, only with the `$HOME`
  defaults.** A compiled binary with no receipt, whose Loom record names its
  canonical path and its current digest, registers a live receipt that binds
  `$HOME/.config/mimir`, `$HOME/.local/share/mimir`, and `$HOME/.cache/mimir`.
  Adoption fails closed: when `$HOME` is not absolute, or when
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, or `XDG_CACHE_HOME` (and, outside macOS,
  `XDG_STATE_HOME`, which holds Loom's record) is set to anything but its
  `$HOME` default, the run writes no receipt. It prints one line to stderr
  naming every such variable and both ways to adopt: unset the variables for
  the `$HOME` defaults, or, when the directories under them are the real
  ones, install with the root `install.sh`, which records them (superseded by the
  MMR-555 refinement below). An absolute
  `XDG_STATE_HOME` holds Loom's record itself, so a run with it unset would
  find no record; its remedy is to re-run Loom's `install.sh` with it unset,
  so the record moves to the default, or to install with the root
  `install.sh`. The run then uses the development directories beside the
  binary.
  A run with the real `$HOME` and a temporary XDG root therefore cannot bind
  the installation to that temporary directory. An installation that keeps its
  directories elsewhere takes its receipt from Mimir's own installer, which
  records them, and Loom's installer then upgrades it with them kept. Later
  runs read the receipt, so ambient variables cannot move a registered
  installation.
- **An installer's replacement keeps the bindings.** A receipt whose digest no
  longer matches its binary is re-recorded with its mode and directories when
  Loom's record names that binary and its new digest. This happens after
  `install.sh` runs over an existing installation and after `self-update`.
- **A sandbox or test run adopts nothing.** When `MIMIR_SANDBOX_AUTHORITY` or
  `MIMIR_TEST_POSTGRES_URL` is set, the run ignores Loom's record, because those
  runs keep the real `$HOME` and `XDG_STATE_HOME` beside throwaway directories,
  and an adoption would bind the real installation to them for good. An
  adoption that does happen prints one line to stderr naming the bound config,
  data, and cache directories. To undo an adoption, delete
  `<binary>.installation.json` and run the binary again from the right
  environment.
- **Everything else fails closed.** Bytes that neither record names are refused,
  as before. A copy that no record names gets no receipt and uses the isolated
  development defaults. Loom's self-update refuses to replace a binary that
  `install.sh` did not record.

This moves the binding from install time to first run. The installer still
writes the record that grants authority, and downloading or building a binary
still grants none. The root `install.sh` installs the old binary until cutover.
The `self-update` surface of the Loom CLI is Loom's: `self-update [<version>]
[--channel <channel>] [--check]`. Its `next` channel replaces `MIMIR_NEXT=1`
and `--next`. The Loom CLI shows no update notices, as the old CLI showed
none.

## Refinement (2026-10-28, MMR-555): the Loom installer is the installer

The cutover to the Loom CLI deletes the old binary. `packages/cli/install.sh`
is the installer for Loom-built releases, and the Loom CLI is the only binary
that reads the receipt. The remedies above that name "the root `install.sh`" are
gone from the binary's refusal line: a run that refuses to adopt names the
variables to unset and nothing else, and an installation under custom XDG roots
is adopted only through a receipt an earlier installer already wrote. The
installer's `postInstall` registers the MCP server with Claude Code
(`mcp install --agent claude`), so it runs the installed binary.

The root `install.sh` stays in place, unchanged, until the first stable release
built from the Loom CLI: until then `releases/latest` is an old-CLI release that
treats `mcp install` as a request to serve MCP, which would hang the Loom
installer. The cut commit of that release deletes it and moves the README to
`packages/cli/install.sh` (superseded by the MMR-603 refinement below: the cut
keeps the root URL and replaces the file with a copy of the managed installer).

## Refinement (2026-10-29, MMR-603): the install URL stays at the root

The v0.26.0 cut keeps the install URL at the repository root rather than moving
it to `packages/cli/install.sh`. The URL is a published contract, copied into
the README, the user docs, the Mimir skill, and users' own scripts, so it must
not follow the monorepo's package layout. The cut replaces the root `install.sh`
with a byte-for-byte copy of the installer `loom init` manages, and
`packages/cli/src/installer.test.ts` fails while the two differ.
`packages/cli/install.sh` remains the rendered source. The copy goes when Loom
can render the managed installer at a chosen path (LM-s40); a symlink cannot
replace it, because `raw.githubusercontent.com` serves a symlink's target path
as text. Releases before 0.26.0 install with the installer at their own tag,
such as `v0.25.0/install.sh`.
