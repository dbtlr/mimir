# Setup: install, bind, create, backfill

## Preflight

`command -v mimir` — if missing, install (macOS arm64 / Linux):

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
```

(or `bun add -g mimir` from source). Work state lives in one local SQLite file,
`store.sqlite` in the installation's data directory (default
`$XDG_DATA_HOME/mimir`, i.e. `~/.local/share/mimir`). Mimir creates and migrates
it on first use, so there is no preflight beyond the binary. An install on the
shared Postgres backend (`[store] backend = "postgres"` plus `url`) has one
preflight: `mimir store upgrade` creates or upgrades the schema and must run
before any other command (every other verb refuses on a mismatched schema).
`[store] backend = "norn"` is a fatal config error, and a v0.20 config with no
`backend` line (Norn was its default) opens an empty store. Export the old vault
with mimir v0.20 (`mimir store export <file>`), remove any `backend = "norn"`
line, then import the document with `mimir store import <file>` (a preview; add
the `--apply` flag to write it).

## Remote installs (paired with a host)

A `config.toml` with `[host] url` is a remote install: every command reads and
writes the host's board with the device token in `credentials.toml`, and the
install has no local store. `[store]` and `[host]` exclude each other. The
`store` commands refuse on a remote install; backups run on the host with
`mimir-host store export`.

- **Check it with `mimir doctor`.** A connection, credential, or version error
  from any command means run `mimir doctor` and follow the remedy each finding
  names. A clean setup prints `doctor: no problems found`.
- **Pairing needs the operator.** `mimir pair <url>` prints a code on stderr
  and then waits, up to ten minutes, until someone approves it on the host
  (`mimir-host approve <code>` inside the host container, or the console's
  `/pair` page). Run it in the background or read its stderr as it streams,
  give the user the code and the link it prints, and ask them to approve.
  Never approve on their behalf.
- **Pairing an install that has a board moves the board first.** `mimir pair`
  refuses while `[store]` is present. Do not delete `[store]` or the local
  store to get past the refusal: that strands the board. Move it in order:
  `mimir store export board.json`; on the host's machine,
  `docker compose -f deploy/compose.yaml exec -T mimir mimir-host store import - < board.json`
  (a preview), then the same with `--apply`; remove `[store]`;
  `mimir pair <url>`; `mimir doctor`. Confirm the
  move with the user before the import, because it writes to the host. A
  default SQLite install has no `[store]` and is not refused, so export its
  board before pairing it too.

## Case 1 — the project exists, this working copy isn't bound

A clone binds itself when its `origin` matches the remote a project records. If
`mimir bind` still reports it unbound but the project exists in the store
(`mimir projects` lists its key):

```sh
mimir bind KEY        # validates KEY exists, writes git config mimir.project
```

Done. When the project has no remote yet and the origin is a network remote,
`bind` also records it on the project, so every other clone of the repo binds for
free. Linked worktrees share the binding. A clone with no `origin`, or one whose origin several projects share,
needs its own `mimir bind KEY`.

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

The bind is per clone and is not committed.

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
