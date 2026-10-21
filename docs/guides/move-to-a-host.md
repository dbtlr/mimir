---
description: Move a CLI-only install's board into a Mimir host, pair the CLI with the host, and confirm that the CLI works through it.
---

# Move a CLI-only install to a host

A CLI-only install keeps its board in a store it opens itself: the SQLite file
`store.sqlite` in its data directory, or the Postgres database that `[store]`
names in `config.toml`. After the move, the [host](host.md) owns the board. The
CLI reads and writes it through the host with a device token, and it holds no
store and no database credentials.

The steps use two machines: the one with the CLI and the one that runs the
host. They can be the same machine. The host commands use
`deploy/compose.yaml`, as the [host guide](host.md) does. Add
`-f deploy/compose.postgres.yaml` for a host on Postgres.

## Before you start

- Stop agents and other sessions that write to the board. Work recorded after
  the export stays in the old store.
- Run a host at least as new as the CLI. `mimir pair` checks the host's version
  window before it files a request, and refuses with the remedy when the CLI is
  outside it.

## 1. Export the board

On the CLI's machine:

```sh
mimir store export board.json
```

The export is one transfer document that keeps every id, sequence, and
timestamp. It refuses to overwrite an existing file. See
[Postgres store](postgres-store.md) for what the document holds.

## 2. Start the host

Start a host on an empty store, as [Run the Mimir host](host.md) describes:

```sh
docker compose -f deploy/compose.yaml up -d --wait
```

When the CLI runs on another machine, make the host reachable from it first.
See [Reach it from another device](host.md#reach-it-from-another-device).

## 3. Import the board on the host

Copy `board.json` to the host's machine. Preview the import, then apply it:

```sh
docker compose -f deploy/compose.yaml exec -T mimir mimir-host store import - < board.json
docker compose -f deploy/compose.yaml exec -T mimir mimir-host store import - --apply < board.json
```

The preview reports what the import would create and writes nothing. The
import refuses when the host already holds one of the document's projects, so
it cannot half-merge into a board that already has them. `-T` keeps the
document's bytes off a terminal.

## 4. Remove `[store]` from the CLI's config

Delete the `[store]` section, with every key under it, from the CLI's
`config.toml`. A default SQLite install has no `[store]`, so skip this step.

`mimir pair` refuses while `[store]` is present. Its message names the config
file, and the line after it lists the steps of this guide:

```text
/home/ana/.config/mimir/config.toml declares [store]: this install owns a local board, and pairing would leave it behind
```

The old store is not changed. The CLI no longer reads it after pairing. Keep it
as a backup until step 7 confirms the board on the host.

## 5. Pair the CLI with the host

Run `mimir pair` with the host's URL:

```sh
mimir pair http://localhost:64647
```

The CLI shows a code and waits:

```text
pairing code K7QM-2P9D
approve with mimir-host approve K7QM-2P9D on the host
or open http://localhost:64647/pair?code=K7QM-2P9D
the request expires at 2026-10-21 14:32 EDT
◐ Waiting for approval · 4.2s
```

Check that the code matches, and approve it on the host:

```sh
docker compose -f deploy/compose.yaml exec mimir mimir-host approve K7QM-2P9D
```

Or open the link and approve the request on the console's `/pair` page. The
CLI reports the pairing:

```text
✔ Approved · 6.1s
✓ paired as laptop with http://localhost:64647 (host 0.26.0)
```

It saves its device token in `credentials.toml` and the host's URL as
`[host] url` in `config.toml`. See
[Pair the CLI with a host](host.md#pair-the-cli-with-a-host) for its flags and
for what happens when a request is denied or lost.

## 6. Check the setup

```sh
mimir doctor
```

A clean remote setup passes every check:

```text
✓ host configuration
✓ credentials file (0600)
✓ credentials origin
✓ host health
✓ version window
✓ device token
record health: run mimir-host doctor inside the host container
✓ doctor: no problems found
```

Doctor stops at the first check that fails and names its remedy. Without color,
`[ok]` replaces `✓`.

## 7. Confirm the board

Read a task from the imported board, by the id it had before the move:

```sh
mimir get AUR-12
```

The CLI reads it through the host, and every later read and write goes there
too. The projects, tasks, and history from the export keep their ids. Delete the
old store once you no longer need it as a backup.

## Move the other machines

Export and import once, because the host now holds the board. Each other
machine that used the same board removes its `[store]` (step 4), pairs with
the host (step 5), and checks the result with `mimir doctor` (step 6).

## Source

`packages/host/scripts/migration.integration.test.ts` runs these steps against
the built image: it exports a board from a CLI on SQLite, imports it into the
host, pairs the CLI, checks `mimir doctor`, and reads and writes the imported
work through the host. It starts the image with `docker run` and reaches it with
`docker exec -i` where this guide uses Compose, and it runs the CLI's commands
with `--device`, `--no-input`, and `-f json` so that a script can read them. `packages/cli/src/commands/pair.ts` (`mimir pair`),
`packages/cli/src/commands/store.ts` (export and import), and
`packages/host/src/admin/` (`mimir-host`).
