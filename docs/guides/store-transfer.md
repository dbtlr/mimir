---
description: Export a SQLite store to a transfer document, import it elsewhere, and move a Norn vault into the current store.
---

# Store transfer

`mimir store export` and `mimir store import` move work state through one
backend-neutral JSON document. The export is the backup for a local SQLite
store, and the import restores it or loads a board into a new store. A paired
CLI has no store; the host runs the same commands as `mimir-host store export`
and `mimir-host store import` ([Back up the store](host.md#back-up-the-store)).

## Back up

Pairing requests and device tokens are host transport credentials and are excluded
from export and import. Moving work state to another host requires pairing its
devices again. Import preserves any credentials already held by the target host.

`mimir store export` writes work state as one JSON document:

```sh
mimir store export board.json
```

The document holds the stored work-state facts: the projects with their sequence
counters, the nodes, the dependency edges, the tags, the annotations, the
artifacts with their frozen content, the seeds with their history, the
scratchpads, the owned prose sections, and the transition log. It holds nothing
derived — status and rollups are recomputed on read from these same
facts. Identity is preserved: every `KEY-seq`, `KEY-aN`, and `KEY-sN`, every
timestamp, and the counters. The document carries a `schema_version` of its own,
separate from the database schema version, so a later binary knows what it
reads. The transfer document carries work state only. The database schema
enforces its identities and references when records are written.

Export refuses to overwrite an existing file. Name a new path, or remove the
old backup first. Write `-` instead of a path to send the document to stdout,
and `-` in place of the import's path to read it from stdin.

To restore, import the file into an empty store. A local SQLite store creates
and migrates its schema when it opens:

```sh
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
To share the board across machines, import the document into a
[host](host.md) instead, as [Move to a host](move-to-a-host.md) describes.

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

A v0.20 install that enabled the snapshot timer has a snapshot
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
