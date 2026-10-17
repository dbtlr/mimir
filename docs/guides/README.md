# Operator guides

Recipes for running a `mimir` install day to day: the host container, self-update, and where the
binary should live. Each page is self-contained — read the one you need.

| Guide                                       | Covers                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [Mimir host](host.md)                       | Running the host container over SQLite or Postgres: network access, accepted hosts, health, errors, upgrades, and backups |
| [Self-update](self-update.md)               | `mimir self-update`'s channels, verification, and failure behavior   |
| [Install location](install-location.md)     | Where the binary belongs, and registering a legacy installation      |
| [Postgres store](postgres-store.md)         | Sharing one board across machines: `[store]`, `store upgrade`, export/import, doctor |
| [Development sandboxes](development-sandboxes.md) | Isolated installations for testing the CLI and installer         |

A recipe worth keeping lands as a direct edit to one of these pages in the PR
that discovers it (or a stub here if it isn't fully statable yet) — a recipe
parked for later tends to rot instead of landing.
