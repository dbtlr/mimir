### Added

- **`mimir service` on Linux** (MMR-54). `service` and `setup` now manage systemd
  user units (`com.dbtlr.mimir.serve.service`, and a `com.dbtlr.mimir.snapshot.timer`
  that runs a oneshot snapshot service), with the same verbs, output, and event log
  as launchd on macOS. Self-update restarts a loaded serve unit on Linux too. See
  `docs/guides/service-lifecycle.md` for linger and the systemd details.
- **`bun run sandbox service-verify`** (MMR-54). A development command that proves
  install, status, restart, kill-and-recover, stop, start, and uninstall against
  the real supervisor without touching live units: a vault sandbox under launchd
  or systemd on the host, or systemd in a disposable container installed through
  `install.sh`. A manually dispatched **Service verify** workflow runs it on macOS
  and Linux runners.

### Changed

- **The supervisor fence is per installation** (MMR-54). A sandbox installation
  now derives its own unit names (`com.dbtlr.mimir.sandbox-<id>.*`) and may drive
  only those; only a live installation may drive the live names, which are
  unchanged, so existing installs need no migration. `service install` also
  creates a missing unit or log directory instead of failing to start the unit.
  See the refinement in
  `docs/decisions/0031-installation-authority-and-disposable-development.md`.

### Fixed

- **`service uninstall` stops a unit whose file is gone** (MMR-54). A bare
  `mimir service uninstall` now also tears down a unit the supervisor still
  runs after its unit file was deleted, instead of reporting nothing installed
  while the daemon keeps serving.
