# Start with an agent-driven repository

This guide takes Mimir from a fresh install to a repository an agent can resume
without reconstructing work state from chat history.

## Install

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
```

[Install location](../guides/install-location.md) explains the two installers,
the Loom installer's `--dir` and version arguments and its Claude Code MCP
registration, and how the first run binds the installation.

The standalone binary does not require Bun or any other program. By default
Mimir keeps work state in one SQLite file, `store.sqlite`, in its data
directory. Mimir creates the file on first use, so no setup step follows the
install.

A team that shares one board across machines can use a PostgreSQL database
instead by setting the `[store]` section of the configuration. See the
[Postgres store guide](../guides/postgres-store.md). Back up either store with
`mimir store export <file>`.

## Create a project

A project is the root of one work hierarchy. Its key is short, uppercase, and
immutable.

```sh
mimir create project "Aurora" --key AUR --yes
```

Create an initial home for work, then add a task:

```sh
initiative_id=$(mimir create initiative "Release 1.0" --parent AUR -f ids)
phase_id=$(mimir create phase "Sign-in reliability" --parent "$initiative_id" -f ids)
task_id=$(mimir create task "Verify account recovery" --parent "$phase_id" --size s -f ids)
```

The `ids` format captures each allocated ID for the next command. Sequence
numbers are not an interface for predicting the next ID.

## Bind the repository

Run this from the repository root:

```sh
mimir bind AUR
```

Binding writes `mimir.project` into the clone's git config, and records the
clone's `origin` remote on the project when the project has none. Commands in
this clone and its linked worktrees default to Aurora:

```sh
mimir overview
mimir next
```

The binding stays in your clone and never lands in a commit. A fresh clone of a
repository whose `origin` matches the project's remote binds itself on its first
command that needs a project. `mimir bind` with no key prints the bound project,
or exits non-zero with `unbound: run mimir bind KEY`. A `.mimir.toml` left over
from an earlier version is ignored and can be deleted.

## Connect an agent

Install Mimir's bundled skill into your home folder for every agent it supports,
or for one with `--agent claude` or `--agent agents`. Add `--project` to keep
the skill with the current repository instead:

```sh
mimir skills install
```

The installer already registered `mimir mcp` with Claude Code. Run
`mimir mcp install --agent claude` to register it again, or `mimir mcp config`
to print a client configuration for another agent. Codex cannot connect to the
server's MCP protocol revision yet. The skill
teaches the workflow and lifecycle contract; MCP exposes the same core reads and
writes as tools. See [Work with agents](working-with-agents.md) for the division
of responsibility.

## Begin and finish work

Continue in the same shell, or replace `$task_id` with the task ID printed
earlier:

```sh
mimir overview
mimir next
mimir start "$task_id"
# do and verify the work
mimir done "$task_id"
```

Use `submit` instead of `done` when the work is ready but still needs human
review. Mimir's status should change when reality changes, not at the end of a
long session.

## Open the console

The console comes from the Mimir host container, not the `mimir` binary. Follow
the [host guide](../guides/host.md) to run it, then open its URL. The console
shows all projects and provides the operator's path for inspection, authoring,
lifecycle changes, and grooming.

## Work through a host

A host can own the board instead of the CLI. The CLI then pairs with the host
once and reads and writes through it, with no local store and no database
credentials. Every machine and agent that pairs with the host shares the same
board, and the console shows it.

```sh
mimir pair https://box.tail1234.ts.net
mimir doctor
```

`mimir pair` prints a code to approve on the host, in the console's `/pair`
page or with `mimir-host approve <code>`. `mimir doctor` then checks the
connection. To bring an existing board along, follow
[Move a CLI-only install to a host](../guides/move-to-a-host.md) before you
pair.
