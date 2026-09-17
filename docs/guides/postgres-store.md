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
- `url` is a libpq-style connection URL. It carries the credential, so keep the
  file readable by you alone (`chmod 600`). There is no environment override.
- `[vault]` is ignored on a Postgres install; there is no vault behind it.

The database must exist and the user must own it. The binary creates every
table itself (next section). Keep the database on a private network: the bridge
adds no authentication beyond Postgres's own and no transport encryption of its
own, so use `sslmode=require` in the URL when the network is not trusted.

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
  apply. The portable backup is the transfer document produced by the store
  export (MMR-380), which also moves a board between backends.
- **Doctor checks the database.** `mimir doctor` reports the schema version
  against the binary, a dangling parent or dependency reference, a sequence
  counter that fell behind its rows, and an orphan artifact link or scratchpad
  anchor. A store it cannot reach is not a finding: the command fails with a
  nonzero exit instead. There is no repair pass; every state it reports is
  unreachable through the binary and points at a hand edit.

## Moving an existing vault

Export the vault on the Norn install and import it on the Postgres install
(MMR-380). Identity is preserved end to end: every `KEY-seq`, `KEY-aN`, and
`KEY-sN`, every timestamp, and the sequence counters, so a create after the
import never collides with an imported id.
