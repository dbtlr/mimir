# Start with an agent-driven repository

This guide takes Mimir from a fresh install to a repository an agent can resume
without reconstructing work state from chat history.

## Install and set up the vault

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
mimir setup
```

The standalone binary does not require Bun. Mimir does require `norn` on
`PATH`; Norn owns all reads and writes to the Markdown vault.

Setup is safe to run again. It can change the vault path, configure the console
port, install the local service, and enable scheduled Git snapshots. See the
[operations guides](../guides/README.md) for service details.

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

Binding writes `.mimir.toml`. From this directory and its descendants, commands
default to Aurora:

```sh
mimir overview
mimir next
```

Commit `.mimir.toml` so every checkout shares the same project identity.

## Connect an agent

Install Mimir's bundled skill for the agent environment you use:

```sh
mimir skill install --global --agent codex
# or
mimir skill install --global --agent claude
```

Configure `mimir mcp` as an MCP server when the agent supports MCP. The skill
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

```sh
mimir serve
```

Open the URL printed at startup. The console shows all projects and provides
the operator's path for inspection, authoring, lifecycle changes, and grooming.
