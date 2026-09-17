# Postgres store

Run one board from several machines by pointing every install at one Postgres
database. The Norn-managed markdown vault stays the default, local backend; the
Postgres backend is the shared one ([ADR 0030](../decisions/0030-postgres-store-backend-shared-store-bridge.md)).
The fence is per install: one install is wholly on one backend.

## Configure

In `~/.config/mimir/config.toml` (`$XDG_CONFIG_HOME` if set):

```toml
[store]
backend = "postgres"
url = "postgres://mimir:secret@db.example.internal:5432/mimir"
```

- `backend` selects the store. Leave it out, or set `norn`, for the vault.
- `url` is a libpq-style connection URL. It carries the credential; the binary
  writes the file 0600 itself, so keep it that way. There is no environment
  override.
- `[vault]` is ignored on a Postgres install; there is no vault behind it.

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
- **No git snapshots.** `vault snapshot` and the snapshot launchd unit do not
  apply. `store export` is the backup on this backend; see [Back up](#back-up).
- **Doctor checks the database.** `mimir doctor` reports the schema version
  against the binary, a dangling parent or dependency reference, a sequence
  counter that fell behind its rows, and an orphan artifact link or scratchpad
  anchor. A store it cannot reach is not a finding: the command fails with a
  nonzero exit instead. There is no repair pass; every state it reports is
  unreachable through the binary and points at a hand edit.

## Back up

`mimir store export` writes the whole store as one JSON document:

```sh
mimir store export vault.json
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
old backup first. Write `-` instead of a path to send the document to stdout.

To restore, create the schema in an empty database and import the file:

```sh
mimir store upgrade
mimir store import vault.json
mimir store import vault.json --apply
```

The first import is a preview: it runs every check the write would run and
reports what it would create, but writes nothing. `--apply` writes it. An
import refuses when the target already holds one of the projects in the
document, so a restore cannot half-merge into a live board.

## Moving an existing vault

Export from the vault, then import into the Postgres database. Export reads the
store seam, so the source backend does not matter.

On the machine that holds the vault:

```sh
mimir store export vault.json
```

Copy the file to the target machine. There, point the install at the database:

```toml
[store]
backend = "postgres"
url = "postgres://mimir:secret@db.example.internal:5432/mimir"
```

Create the schema, preview the import, then write it:

```sh
mimir store upgrade
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

If an import stops part way, run the same file again with `--resume`:

```sh
mimir store import vault.json --apply --resume
```

`--resume` skips every record already present and identical to what this import
would write. A record that is present but different stops the import and names
it: resume finishes a partial run of one document, it does not merge two
different ones.
