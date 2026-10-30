- **`mimir store upgrade`** (MMR-582). The command is removed and now fails as an unknown command. A SQLite store migrates whenever the CLI opens it, so `store upgrade` had nothing left to do. `store export` and `store import` stay.
- **A CLI whose `[store]` names Postgres** (MMR-582). A `backend = "postgres"` or a `url` in the CLI's `[store]` now makes every command that opens the local store fail with a config error that points to `mimir pair` and `docs/guides/move-to-a-host.md`. The host is the only Mimir program that opens Postgres; the CLI opens a SQLite store, or reaches a host.

### Migration

**Affected surface.** Scripts that run `mimir store upgrade`, CLI installs whose `config.toml` has `[store] backend = "postgres"` or `[store] url`.

**Why.** The host owns the board and is the only program that opens Postgres, so a CLI no longer carries a Postgres driver path or a schema migrator of its own.

**Before and after.**

```toml
# before: config.toml of a CLI that opens Postgres itself
[store]
backend = "postgres"
url = "postgres://user:secret@db.example.test/mimir"

# after: config.toml of a CLI paired with a host
[host]
url = "https://mimir.example.test"
```

**Steps.**

1. Run a host against the database that `[store] url` names; the host migrates it when it starts. `docs/guides/host.md` covers a host on Postgres.
2. Remove the `[store]` section from the CLI's `config.toml`, and delete any script line that runs `mimir store upgrade`.
3. Run `mimir pair` against that host. `docs/guides/move-to-a-host.md` walks through pairing.

**Validation.** Run `mimir doctor` and `mimir overview`. Both answer from the host.
