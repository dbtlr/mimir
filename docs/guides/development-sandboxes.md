---
description: Reproduce Mimir development and migration tests with registered sandbox installations, disposable Postgres, and native snapshots.
---

# Development sandboxes

Development uses disposable Postgres containers. Production configuration belongs
to a registered live installation; building a binary does not grant that authority.
See [ADR 0031](../decisions/0031-installation-authority-and-disposable-development.md).

## Prerequisites

Use Bun 1.4.0 from `.tool-versions` and a running Docker-compatible engine.
Run `bun install --frozen-lockfile`. The sandbox CLI uses the pinned published Loom
packages. It invokes Postgres tools inside the pinned Postgres container; host
`psql`, `pg_dump`, and `pg_restore` installations are unnecessary.

The repository-local command is `bun run sandbox`. `--help` describes its commands.
No sandbox command accepts a database URL. The former `MIMIR_TEST_POSTGRES_URL`
override is rejected with instructions to use the disposable test lane.

## Fixtures and tests

```sh
bun run sandbox create
bun run sandbox verify <sandbox-id>
bun run sandbox run <sandbox-id> -- overview
bun run sandbox destroy <sandbox-id>
```

`create` builds the checkout, creates a container with random credentials and a
loopback port, installs the binary into isolated directories, applies migrations,
and seeds the standard fixture. `create --binary ./dist/mimir` uses an existing
candidate instead. It prints the sandbox identity. The fixture includes two projects,
a hierarchy with dependent tasks, transitions, annotations, artifacts, a seed, and
a scratchpad. Its revision is recorded with the run.

```sh
bun run test
bun run test:postgres
bun run test:sandbox
```

The ordinary suite includes PGlite tests without a server. `test:postgres` provisions
an owned server and runs the real-Postgres conformance and concurrency cases.
`test:sandbox` builds the candidate and exercises a real native snapshot rehearsal.
Tests do not use the live installation or its database.

State lives under `.dev/sandboxes/<sandbox-id>`. Each sandbox has its own installed
binary, receipt, authority file, config, data, cache, and run records. Treat these
files as generated state. An installed sandbox can run normal Mimir commands from
any directory because its receipt selects its configuration.

Successful automatic runs remove their containers. Interactive sandboxes remain
until `destroy`. On failure, the CLI reports the retained identity and cleanup
command. Never substitute a raw `docker rm` or directory deletion for that command:
the script checks ownership and handles partial cleanup.

## Configure the snapshot source

Create the local, ignored `.dev/sandbox.json` configuration:

```json
{
  "snapshots": {
    "directory": "/path/to/snapshots"
  }
}
```

Relative paths resolve from the checkout. There is no default snapshot directory;
fixture workflows work without one. The backup producer owns this directory and its
schedule. Development only reads published snapshot files.

## Snapshot interchange version 1

Each published snapshot is a directory named by its identity:

```text
snapshots/
  capture-2026-09-17/
    database.dump
    snapshot.json
```

The [versioned JSON Schema](../schemas/postgres-snapshot-v1.schema.json) defines the
sidecar structure. Regenerate it with `bun run sandbox snapshot-schema`.

`database.dump` is a complete `pg_dump --format=custom` archive of the application
database, including its schema, data, and migration state. `snapshot.json` is:

```json
{
  "version": 1,
  "id": "capture-2026-09-17",
  "capturedAt": "2026-09-17T12:00:00Z",
  "postgresVersion": "18.6",
  "pgDumpVersion": "18.6",
  "sha256": "<64 lowercase hexadecimal characters>"
}
```

Versions are numeric version strings, without the command's prose prefix. The
checksum covers the archive bytes. Version 1 supports PostgreSQL server and dump
tool major version 18. Snapshot IDs start with an ASCII letter or digit and contain
only letters, digits, dots, underscores, or hyphens. The metadata identity must
match the directory name.

The producer writes into a hidden staging directory, completes the dump, computes
the checksum, writes the metadata, and atomically renames the directory to its final
identity. Published identities are immutable. No Mimir executable is needed to
produce or restore the native archive. Backing up roles, cluster configuration, and
production recovery policy are separate concerns from this rehearsal interchange.

Restore omits source ownership and ACLs so the sandbox owns the restored objects.
The archive remains a sensitive copy of the source data; neither archives nor
restored data belong in repository fixtures or committed test output.

## Restore and rehearse

```sh
bun run sandbox restore capture-2026-09-17
bun run sandbox upgrade <sandbox-id> --to ./dist/mimir
bun run sandbox rehearse capture-2026-09-17 --to ./dist/mimir
```

`restore` checks the manifest, checksum, and supported versions, then restores into
a fresh database without applying migrations. `upgrade` installs the candidate,
preserves the sandbox's bindings, invokes its real `store upgrade`, and verifies its
doctor findings and Store export. Restore refuses archives without existing Mimir migration state, so an empty or
unrelated database cannot pass as a migration rehearsal. The source-level integrity worker also checks the
current Store seam. Candidates must support installation receipts; older binaries
that cannot enforce the boundary are refused before replacing an installation.

`rehearse` composes restore, upgrade, verification, and cleanup. It retains its report
under `.dev/sandbox-results`. Use `latest` instead of an explicit snapshot identity
only when selection by capture time is intended. The selected identity and checksum
are recorded once, so replay can use the exact snapshot.

Reproduction records identify the container image digest, executable digest, fixture
revision or snapshot checksum, and verification result. Execution times, credentials,
and resource IDs differ between runs. A repeatable outcome does not require those
values to be identical.

## Live installation transition

The release installer performs explicit registration and resolves Mimir's XDG
directories. Receipt-aware updates preserve those bindings. A release predating
receipts must be replaced through the new installer to become registered; copying
a new binary over it is insufficient. This workflow never updates an existing live
installation as part of development or testing.
