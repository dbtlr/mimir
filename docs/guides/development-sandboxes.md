---
description: Run the development host and the real-Postgres tests against disposable Postgres, exercise the installer in a sandbox home, and evaluate the agent skill with real agents.
---

# Development sandboxes

Development uses disposable Postgres containers for the host and the real-Postgres
tests. The CLI opens no Postgres: a `mimir` whose `[store]` names Postgres refuses,
and the host is the only Mimir program that opens it. Production configuration
belongs to a registered live installation; building a binary does not grant that
authority. See [ADR 0031](../decisions/0031-installation-authority-and-disposable-development.md).

## Prerequisites

Use Bun 1.4.4 from `.tool-versions` and a running Docker-compatible engine.
Run `bun install --frozen-lockfile`. The sandbox CLI uses the pinned published Loom
packages. It invokes Postgres tools inside the pinned Postgres container; a host `psql`
installation is unnecessary.

The repository-local command is `bun run sandbox`. `--help` describes its commands.
No sandbox command accepts a database URL. The former `MIMIR_TEST_POSTGRES_URL`
override is rejected with instructions to use the disposable test lane.

## Tests

```sh
bun run test
bun run test:postgres
bun run test:sandbox
```

The ordinary suite includes PGlite tests without a server. `test:postgres` provisions
an owned server and runs the real-Postgres conformance and concurrency cases.
`test:sandbox` builds the candidate and exercises the installer, self-update, and
MCP binding against it. Tests do not use the live installation or its database.

State lives under `.dev/sandboxes/<sandbox-id>`. Each Postgres sandbox has its own
authority file, directories, and run records. Treat these files as generated state.

## Smoke-test a CLI build

The installed `mimir` is the live installation, and it reaches the live board
through the host. Do not run its write verbs outside an authorized operation.
Smoke a build instead.

A build takes its runtime paths from the first of these that applies:

1. the installation receipt beside the binary (`<binary>.installation.json`);
2. a sandbox authority, named by a sandbox receipt or by
   `MIMIR_SANDBOX_AUTHORITY`;
3. a `.dev` directory: the repository's for `bun run mimir`, and one beside the
   binary for a compiled build, such as `dist/.dev` for `dist/mimir`.

XDG variables choose a live installation's directories only when it is first
adopted, and the receipt keeps them after that. Setting them does not isolate a
run of the installed binary from its registered paths.

Copy the build into a fresh directory and run the copy there, so its `.dev` is
disposable:

```sh
bun run build
smoke=$(mktemp -d)
cp dist/mimir "$smoke/mimir"
"$smoke/mimir" create project "Smoke" --key SMK -y
```

To refresh the copy, remove the old binary before copying the new one. macOS
kills a signed binary that was overwritten in place, and the next run exits
with status 137.

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

Each run is a sandbox with no database in a temporary directory outside the checkout, so
no git clone above it binds the unbound scenarios. It has its own
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

## Run the development host against Postgres

The host exposes `GET /health` with its build version and supported schema version,
without querying the store. The container's Docker health check probes this route
with Bun and honors `MIMIR_PORT`. Record diagnostics reach the console through its `doctor` server function,
scoped to one project; they exclude CLI configuration permission findings.

```sh
bun run sandbox create
bun run sandbox host <sandbox-id>
bun run sandbox host <sandbox-id> --port 6543
```

`create` starts a container with random credentials and a loopback port, waits for
it to accept connections, and prints the sandbox identity. The database is empty;
the host migrates it when it starts.

`host` checks the existing sandbox's authority, Docker daemon identity, and
container ownership before starting `packages/host` in development mode. It
supplies only that sandbox's generated Postgres endpoint. Ambient `MIMIR_*`
and `PG*` variables are cleared, including database secret files and host
configuration. The development host still checks the supplied endpoint against
the authority file before opening a connection.

The server binds to `127.0.0.1`, defaults to port `64747`, and refuses an occupied
port. Logs stream to the terminal. Press Ctrl+C to stop the server and its child
processes; the sandbox remains available. A session stops after twelve hours.
Use `sandbox destroy <sandbox-id>` when the sandbox is no longer needed.

Successful automatic runs remove their containers. Interactive sandboxes remain
until `destroy`. On failure, the CLI reports the retained identity and cleanup
command. Never substitute a raw `docker rm` or directory deletion for that command:
the script checks ownership and handles partial cleanup.

## Live installation transition

The [installation guide](install-location.md#upgrade-an-earlier-installation)
describes the operator procedure. The release installer records the binary in
Loom's installation record, and the binary's first run registers the receipt and
resolves Mimir's XDG directories. Updates to a registered installation preserve
those bindings.

`packages/sandbox/src/cli-installer.integration.test.ts` runs the installer
against a fake GitHub release feed in a sandbox home: a fresh install, the first
run's adoption, self-update across two builds, the `next` channel, and an
installation an earlier installer registered. The post-install registration
runs against a stand-in `claude` on `PATH`.

The test runs the repository's shell installer against the compiled candidate.
Only the download transport uses a local `curl` substitute. The test verifies the
new receipt, configuration and cache preservation, and unchanged board contents.
A second installation verifies that existing bindings survive different ambient
XDG values. This is a modeled layout transition, not a run of an old release.

The Loom installer stages the download as `.mimir.XXXXXX` beside the binary and
the record as `.install.json.XXXXXX` in Loom's installation directory, then
renames each into place. The binary's first run writes Mimir's receipt through
`<binary>.installation.json.<uuid>.tmp`. Handled errors remove temporary files.
Abrupt termination can leave them behind; after an interrupted install, look for
those three names. The renames are separate operations, so interruption can leave
a binary without a record, which `self-update` refuses until the installer runs
again.

This workflow never updates an existing live installation during development
or testing. Live-mode records and receipts exist only inside the disposable
test layout.
