# Setup: install, bind, create, backfill

## Preflight

`command -v mimir` — if missing, install (macOS arm64 / Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
```

(or `bun add -g mimir` from source). The store is a single user-global SQLite file
(`$XDG_DATA_HOME/mimir/mimir.db`, default `~/.local/share/mimir/mimir.db`;
`MIMIR_DB` overrides). Migrations apply automatically on first run.

## Case 1 — the project exists, this working copy isn't bound

A checked-in `.mimir.toml` normally travels with the repo. If it's absent but the
project exists in the store (`mimir get KEY` succeeds):

```sh
mimir bind KEY        # validates KEY exists, writes ./.mimir.toml
```

Done. Commit the file — every clone is then bound for free.

## Case 1b — `.mimir.toml` exists but project is missing from the store

A cloned repo (or a machine whose store was wiped) may have a `.mimir.toml` that
names a key whose project has never been created locally. `mimir status KEY`
(and most other commands) will report `no project KEY`.

```sh
cat .mimir.toml          # confirm the bound key
mimir status KEY         # "no project KEY" → project doesn't exist in this store
# Create it with the same key, then you're bound automatically:
mimir create project "Display Name" --key KEY -y
```

The key is immutable, so use the exact value from `.mimir.toml`. No `mimir bind`
step is needed — the toml is already there.

## Case 2 — new project

**The key is immutable. Confirming it with the user is the one mandatory
stop-and-ask in this skill — even when the user already named one.**

1. Propose a 2–4 uppercase-letter key derived from the project name (`mimir` → `MMR`),
   with one or two alternates. Ask the user to confirm. The CLI enforces this gate:
   without `-y`/`--yes`, `create project` refuses non-interactively (exit 2) —
   passing `--yes` is the record that confirmation happened.
2. Then:

```sh
mimir create project "Display Name" --key KEY -y
mimir bind KEY
```

Commit `.mimir.toml`.

## Structure: start minimal — never pre-scaffold

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
