---
description: Reproduce Mimir development and migration tests with registered sandbox installations, disposable Postgres, and native snapshots, and evaluate the agent skill with real agents.
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
`test:sandbox` builds the candidate and exercises a real native snapshot rehearsal
and the legacy installer transition. Tests do not use the live installation or
its database.

State lives under `.dev/sandboxes/<sandbox-id>`. Each sandbox has its own installed
binary, receipt, authority file, config, data, cache, and run records. Treat these
files as generated state. An installed sandbox can run normal Mimir commands from
any directory because its receipt selects its configuration.

Successful automatic runs remove their containers. Interactive sandboxes remain
until `destroy`. On failure, the CLI reports the retained identity and cleanup
command. Never substitute a raw `docker rm` or directory deletion for that command:
the script checks ownership and handles partial cleanup.

## Verify the service lifecycle

```sh
bun run sandbox service-verify
bun run sandbox service-verify --target container
bun run sandbox service-destroy <sandbox-id>
```

`service-verify` proves `mimir service` against the real supervisor. It installs
the candidate (built from the checkout, or `--binary <path>`) and then runs
`install all`, `status`, `restart`, a `SIGKILL` that the supervisor must recover
from, `stop`, `start`, and `uninstall`. After each transition it waits for the
supervisor's state and `/api/health` to agree. It records the live units' state
before and after the run and fails if that state changed. The state covers the
running process, whether the unit is loaded and enabled, and a hash of each
live unit file.

- **`--target host`** (the default) creates a vault sandbox under
  `.dev/service-sandboxes/<sandbox-id>`. The sandbox has its own directories,
  a free loopback port, and no database. It is a registered sandbox
  installation, so its units are `com.dbtlr.mimir.sandbox-<sandbox-id>.*` and the
  fence lets it address nothing else. The command uses launchd on macOS and
  systemd user units on Linux. On Linux, `systemctl --user` must reach your
  manager (see [Service lifecycle](service-lifecycle.md#run-without-a-login-session)).
- **`--target container`** checks systemd from any host with Docker. It builds
  a Linux candidate for the engine's architecture and an image with systemd as
  PID 1, a lingering non-root user, and the pinned `norn`
  (`packages/sandbox/container/systemd.Dockerfile`). The repository's
  `install.sh` installs the candidate as that user. Only the download is
  substituted. The result is a live installation of the container alone, with
  its own empty configuration; the command fails if that configuration names
  Postgres. The container runs privileged, which systemd needs for its cgroup
  tree.

Neither target needs `norn` on `PATH`. The sandbox configuration names no store
backend, so it runs on SQLite, and `service install` checks for `norn` only on
the Norn backend.
The report is written to `.dev/sandbox-results/service-<sandbox-id>.json`.
Teardown always unloads the units or removes the container. A failed run keeps
its directory, including the daemon logs, and prints the `service-destroy`
command. For the container target, the logs and the systemd journal are copied
into that directory before the container is removed. `sandbox destroy` also
unloads any units a database sandbox's binary installed.

The **Service verify** GitHub Actions workflow runs the host target on a macOS
runner and an Ubuntu runner, where it enables linger for the runner user. It
runs only when dispatched manually, with a `platform` input of `both`, `macos`,
or `linux`:

```sh
gh workflow run service-verify.yml -f platform=both
```

## Evaluate the agent skill

```sh
bun run sandbox skill-eval
bun run sandbox skill-eval --skill path/to/candidate-skill --repeat 3
bun run sandbox skill-eval --harness codex --scenario cross-board,reopen
```

`skill-eval` gives real Claude Code and Codex agents one request each and grades
what they did. Each scenario seeds a board, makes a request such as "fix the
typo tracked as QEV-2" or "record that QEV-2 waits on another team's parser",
and checks the result. The checks read the store, the working copy, and the
`mimir` commands the agent ran. They never use the agent's own account of its
work. Every scenario also fails a run that guesses a verb the CLI does not have.
`--skill` takes the skill directory under test, so a revision can be measured
before it is embedded in a binary.

Each run is a vault sandbox in a temporary directory outside the checkout, so
no `.mimir.toml` above it binds the unbound scenarios. It has its own
registered installation of the candidate (built from the checkout, or
`--binary <path>`), a git working copy seeded with the scenario's files, and
the skill installed as a project skill. The agent's `PATH` starts with that
installation and drops every directory that holds another `mimir`. Before the
agent starts, the command checks that `mimir` resolves to the sandbox: on the
agent's `PATH` without startup files for Claude, and in the login zsh that
Codex uses. It also refuses a `mimir` alias or function in your interactive
zsh. Before any Claude scenario, one short Claude session records
`type mimir` from its real tool shell, and the evaluation refuses unless that
names the sandbox binary. If that check fails, the report records why and no
scenario runs. The
evaluation stops, and the agents in flight are killed with every command they
started, if a run fails that check or its transcript could have reached any
other `mimir`: a named executable, one in a directory a `PATH=` assignment
adds, or any call through a relative path.

Claude runs with `--setting-sources project`, so user-level skills, `CLAUDE.md`,
and hooks stay out of the run. It keeps your home directory, which it needs for
its login. Codex runs with its home directory and `CODEX_HOME` inside the
sandbox, so user skills and the global `AGENTS.md` stay out. Only `auth.json`
is linked in. If Codex refreshes its login during a run, the new file moves
back to `~/.codex`, and no run keeps a copy.

Agents vary from run to run. Compare two skill revisions with the same
scenarios, models (`--claude-model`, `--codex-model`), and `--repeat`, never
with single runs. The summary prints passes per scenario and harness. The
report at `.dev/skill-evals/<eval-id>/report.json` records the skill and binary
digests, each check's outcome, the `mimir` calls, the skills the agent loaded,
and the final reply. "Writes nothing" checks compare `mimir store export`
before and after the run. Passing runs are deleted unless `--keep` is given.
Failed runs keep their sandbox, including `transcript.jsonl`, and the summary
prints where.

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

The [installation guide](install-location.md#upgrade-an-installation-without-a-receipt)
describes the operator procedure. The release installer performs explicit
registration and resolves Mimir's XDG directories. Updates to a registered
installation preserve those bindings.

`packages/sandbox/src/installer.integration.test.ts` models a legacy installation
layout with an executable placeholder and no receipt. It uses a real synthetic
board in an owned disposable Postgres sandbox. The placeholder never runs.

The test runs the repository's shell installer against the compiled candidate.
Only the download transport uses a local `curl` substitute. The test verifies the
new receipt, configuration and cache preservation, and unchanged board contents.
A second installation verifies that existing bindings survive different ambient
XDG values. This is a modeled layout transition, not a run of an old release.

The installer stages the binary as `<binary>.<uuid>.install` and then writes
the receipt through `<binary>.installation.json.<uuid>.tmp`. Handled errors
remove temporary files. Abrupt termination can leave them behind. The two renames
are separate operations, so interruption can leave a mismatched receipt that
refuses normal state access.

This workflow never updates an existing live installation during development
or testing. The shell installer creates a live-mode receipt only inside the
disposable test layout.
