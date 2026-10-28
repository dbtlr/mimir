- **`mimir serve`, `mimir service`, and the embedded console** (MMR-536). The `mimir` binary is now the CLI and the MCP server only. The console and the transitional `/api` are served by the host container `ghcr.io/dbtlr/mimir-host`; [`docs/guides/host.md`](../../docs/guides/host.md) covers running it. `serve` and `service` now fail as unknown commands with a hint to that guide, and the `--port`, `--no-hunt`, and `--store` flags go with them.
- **`mimir setup`** (MMR-536). It only installed the service and wrote `[serve] port`, and it now fails as an unknown command with a hint to the getting-started guide. The SQLite store is created on first use, and Postgres is configured in the `[store]` section.
- **The `[serve]` config section and `MIMIR_PORT` for the CLI** (MMR-536). A leftover `[serve]` section in a CLI config is ignored. The host keeps `MIMIR_PORT`, `MIMIR_URL`, and `MIMIR_HOSTS`.
- **Sandbox `service-verify` and `service-destroy`** (MMR-536). They exercised the service lifecycle, which no longer exists. The `service-verify` workflow and the `bun run assets` build step are gone with them.
- **`mimir self-update` no longer restarts a service** (MMR-536). It replaces the binary in place and keeps the installation receipt. Its JSON report drops the `restarted` and `restart_failed` fields, and it no longer writes the service event log.

### Migration

**Affected surface.** Scripts and habits that run `mimir serve`, `mimir service`, or `mimir setup`, pass `--port`, `--no-hunt`, or `--store`, set `[serve]` or `MIMIR_PORT` for the CLI, use the sandbox `service-verify` or `service-destroy` commands, or read `restarted` and `restart_failed` from the `self-update` JSON report.

**Why.** The console and the transitional `/api` now run in the host container `ghcr.io/dbtlr/mimir-host`, so the `mimir` binary no longer manages a service.

**Before and after.**

```sh
mimir serve
docker run ghcr.io/dbtlr/mimir-host
```

**Steps.**

1. Run the console from the `ghcr.io/dbtlr/mimir-host` container as [`docs/guides/host.md`](../../docs/guides/host.md) describes.
2. Drop `mimir setup`; the SQLite store is created on first use, and Postgres is configured in the `[store]` section.
3. Stop reading `restarted` and `restart_failed` from the `self-update` JSON report.

**Validation.** Run each script and check that no command fails as unknown; check that the host container serves the console.
