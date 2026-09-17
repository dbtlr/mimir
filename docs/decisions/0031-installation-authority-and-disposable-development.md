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
