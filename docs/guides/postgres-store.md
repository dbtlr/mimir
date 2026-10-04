---
description: Configure a registered Postgres installation, manage its schema, and transfer store records.
---

# Postgres store

Run one board from several machines by pointing every install at one Postgres
database. The local SQLite file is the default backend; the
Postgres backend is the shared one ([ADR 0030](../decisions/0030-postgres-store-backend-shared-store-bridge.md)).
The fence is per install: one install is wholly on one backend.

## Configure

The installer resolves the configuration directory from XDG settings and binds it
to the installed executable. The default is `~/.config/mimir/config.toml`; later
XDG environment changes do not redirect that installation. Uninstalled builds use
isolated development paths and cannot connect to this database. Use the
[development sandbox commands](development-sandboxes.md) for fixtures and migration
rehearsals.

In the bound `config.toml`:

```toml
[store]
backend = "postgres"
url = "postgres://mimir:secret@db.example.internal:5432/mimir"
```

- `backend` selects the store: `sqlite` (the default when it is absent) or
  `postgres`. `backend = "norn"` is a fatal config error; see
  [Moving from a Norn vault](#moving-from-a-norn-vault).
- `url` is a libpq-style connection URL. It carries the credential; the binary
  writes the file 0600 itself, so keep it that way. There is no environment
  override.

The database must exist and the user must own it. The binary creates every
table itself (next section). Keep the database on a private network: the bridge
adds no authentication beyond Postgres's own and no transport encryption of its
own, so when the network is not trusted, set `sslmode` in the URL. The binary
hands the URL to node-postgres 8.23 unchanged, which reads it in
pg-connection-string's default mode:

- `verify-full` is the recommendation: the connection is TLS and the
  certificate is fully validated, CA and hostname. Add `sslrootcert=<path>`
  when the server uses a private CA.
- `verify-ca`, `require`, and `prefer` behave the same as `verify-full` in
  this mode, and node-postgres prints a deprecation warning for each of them.
- `no-verify` encrypts the connection but skips certificate validation.
- `disable` turns TLS off entirely.

The libpq distinctions between those modes (`verify-ca` skipping the hostname
check, `require` validating only with `sslrootcert`) apply only with
`uselibpqcompat=true` in the URL, which this guide does not recommend.

## Create or upgrade the schema

The backend carries an explicit schema version. A fresh database has none, so
the first command on any machine is:

```sh
mimir store upgrade
```

It applies every pending migration in order, under a lock, and prints the
version it moved from and to. Every other command refuses until the schema
matches the binary:

- **Newer schema than the binary.** Another machine already upgraded. Update
  this binary; a newer schema is never downgraded.
- **Older schema than the binary.** Run `store upgrade` on one machine. Every
  binary that shares the database must then be at least that version.

`mimir serve` refuses at startup under the same rule, so the console never
runs against a mismatched schema.

## What changes on a Postgres install

- **Writes are transactions.** Every mutation is one serializable transaction,
  retried whole on a serialization conflict. Two agents on two machines can
  write the same board at the same time without losing an update or minting one
  id twice.
- **No offline mode.** A network outage is a hard failure; there is no local
  copy to fall back to.
- **Backup is an export.** `store export` is the backup on this backend, as on
  SQLite; see [Back up](#back-up).
- **Doctor checks the database.** `mimir doctor` reports the schema version
  against the binary, a dangling parent or dependency reference, a sequence
  counter that fell behind its rows, and an orphan artifact link or scratchpad
  anchor. A store it cannot reach is not a finding: the command fails with a
  nonzero exit instead. Doctor only reports: every state it finds is
  unreachable through the binary, points at a hand edit, and is fixed by hand at
  the database.
- **Doctor checks the config file mode.** The `[store] url` carries the database
  password, so `mimir doctor` warns when the config file grants group or world
  read. It also warns when the file grants group or world write, with or without
  a url: a writer could point the store at its own database. The fix for both is
  `chmod 600` on the file the warning names. The same risk comes from anyone
  who can replace the file, so doctor also warns when another user owns the
  file or a directory above it, or when one of those directories is group- or
  world-writable without the sticky bit. The walk stops at your home directory,
  or at `/` for a config outside home, and also covers a symlinked config's real
  location. Fix a writable directory with `chmod go-w` on the path the warning
  names, and move a config off any path another user owns.

## Back up

`mimir store export` writes the whole store as one JSON document:

```sh
mimir store export board.json
```

The document holds every stored fact: the projects with their sequence
counters, the nodes, the dependency edges, the tags, the annotations, the
artifacts with their frozen content, the seeds with their history, the
scratchpads, the owned prose sections, and the transition log. It holds nothing
derived — status, rollups, and attention are recomputed on read from these same
facts. Identity is preserved: every `KEY-seq`, `KEY-aN`, and `KEY-sN`, every
timestamp, and the counters. The document carries a `schema_version` of its own,
separate from the database schema version, so a later binary knows what it
reads. Export is fail-closed: it refuses, and names the records, when the store
holds something the document cannot carry, so the backup is never quietly
narrower than the store.

Export refuses to overwrite an existing file. Name a new path, or remove the
old backup first. Write `-` instead of a path to send the document to stdout,
and `-` in place of the import's path to read it from stdin.

To restore, create the schema in an empty database and import the file:

```sh
mimir store upgrade
mimir store import board.json
mimir store import board.json --apply
```

Both backends validate the complete transfer document before accessing the target.
Malformed records, unsupported enum values, inconsistent identities, missing
references, and cyclic parents or dependencies produce a validation error naming the offending fields or records.
Repair the document before retrying. Preview, apply, and resume use the same rules.
For resume, supply the original complete document, including records already imported.

The first import is a preview: it runs every decision the write would make —
the version check, the identity checks, the project fence, and the per-record
skip-or-refuse — and reports what it would create, but writes nothing. It
runs the write itself and rolls it back, so the database constraints answer
too. `--apply` writes it. An import refuses when the
target already holds one of the projects in the document, so a restore cannot
half-merge into a live board.

## Moving from a Norn vault

Releases through v0.20 could keep work state in a Norn-managed Markdown vault.
Norn was the v0.20 default, so a v0.20 config with no `backend` line under
`[store]` is a Norn install too. This release removes that backend:
`[store] backend = "norn"` is a fatal config error, and a config with no
`backend` line opens an empty SQLite store and never reads the vault. Move the
vault in two steps: export it with mimir v0.20, then import the document with
this release. The document is the same transfer format
that `store export` writes today, so the import reads it unchanged.

On the machine that holds the vault, with mimir v0.20 still installed, export:

```sh
mimir store export vault.json
```

Install this release. Remove the `backend = "norn"` line if the config has one,
and the `[vault]` section. The install now opens the local SQLite store.
To import into Postgres instead, point the install at the database:

```toml
[store]
backend = "postgres"
url = "postgres://mimir:secret@db.example.internal:5432/mimir"
```

For Postgres, create the schema first. SQLite creates its own on open:

```sh
mimir store upgrade
```

Preview the import, then write it:

```sh
mimir store import vault.json
mimir store import vault.json --apply
```

Verify the result:

```sh
mimir overview
mimir doctor
```

Identity is preserved end to end: every `KEY-seq`, `KEY-aN`, and `KEY-sN`, every
timestamp, and the sequence counters, so a create after the import never
collides with an imported id.

A failed import leaves nothing behind on either backend: the whole import is one
transaction, so a failure rolls it back and the retry is the same command again.
`--resume` skips a record already present and identical to what this import
would write:

```sh
mimir store import vault.json --apply --resume
```

A record that is present but different stops the import and names it: resume
finishes a partial run of one document, it does not merge two different ones.

### Removing a leftover snapshot timer

A v0.20 install that ran `mimir setup --install-snapshot` also has a snapshot
timer unit, which this release no longer manages. It runs a command that no
longer exists, so remove it by hand.

On macOS:

```sh
launchctl bootout gui/$(id -u)/com.dbtlr.mimir.snapshot
rm ~/Library/LaunchAgents/com.dbtlr.mimir.snapshot.plist
```

On Linux:

```sh
systemctl --user disable --now com.dbtlr.mimir.snapshot.timer
rm ~/.config/systemd/user/com.dbtlr.mimir.snapshot.timer ~/.config/systemd/user/com.dbtlr.mimir.snapshot.service
systemctl --user daemon-reload
```
