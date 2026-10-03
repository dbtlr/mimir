# Setup: install, bind, create, backfill

## Preflight

`command -v mimir` — if missing, install (macOS arm64 / Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
```

(or `bun add -g mimir` from source). Work state lives in one local SQLite file,
`store.sqlite` in the installation's data directory (default
`$XDG_DATA_HOME/mimir`, i.e. `~/.local/share/mimir`). Mimir creates and migrates
it on first use, so there is no preflight beyond the binary. An install on the
shared Postgres backend (`[store] backend = "postgres"` plus `url`) has one
preflight: `mimir store upgrade` creates or upgrades the schema and must run
before any other command (every other verb refuses on a mismatched schema).
`[store] backend = "norn"` is a fatal config error; export the old vault with
mimir v0.20 (`mimir store export <file>`), remove the line, then import the
document with `mimir store import <file>` (a preview; add the `--apply` flag to
write it).

## Case 1 — the project exists, this working copy isn't bound

A checked-in `.mimir.toml` normally travels with the repo. If it's absent but the
project exists in the store (`mimir projects` lists its key):

```sh
mimir bind KEY        # validates KEY exists, writes ./.mimir.toml
```

Done. Commit the file — every clone is then bound for free.

## Case 2 — new project

**The key is immutable. Confirming it with the user is the one mandatory
stop-and-ask in this skill — even when the user already named one.**

1. Propose a 2–4 uppercase-letter key derived from the project name (`mimir` → `MMR`),
   with one or two alternates. Check them against `mimir projects --status all`,
   which lists every key already taken, archived ones included. Ask the user to
   confirm. The CLI enforces this gate: without `-y`/`--yes`, `create project`
   refuses non-interactively (exit 2) — passing `--yes` is the record that
   confirmation happened.
2. Then:

```sh
mimir create project "Display Name" --key KEY -y
mimir bind KEY
```

Commit `.mimir.toml`.

## Structure: start minimal

The hierarchy is project → initiative → phase → task, but **create levels only when
the work demands them**. Tasks may hang directly under an initiative; a phase exists
to bound a testable increment, an initiative to hold a theme. An empty four-level
scaffold is hygiene debt on day one, and empty containers read as `new` in every
rollup.

```sh
INIT=$(mimir create initiative "Build the API" --parent KEY -f ids)
mimir create task "Pick the framework" --parent "$INIT" --priority p1 -f ids
```

## Backfilling completed history

Lifecycle verbs are task-only (containers derive their status), and `done` accepts
todo → done directly — so completed history is cheap to record as **summary child
tasks marked done**:

```sh
T=$(mimir create task "Phases 0-3: scaffold, core, read+write surface" --parent "$INIT" -f ids)
mimir done "$T"
```

One summary task per shipped increment is plenty; the point is honest rollups, not
archaeology.
