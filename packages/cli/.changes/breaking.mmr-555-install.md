- **Self-update uses channels and a version argument** (MMR-555). `mimir
  self-update --channel next` replaces `--next` and `MIMIR_NEXT=1`, and `mimir
  self-update <version>` replaces `--tag <tag>`; both old spellings are refused
  with the replacement named. It replaces only a binary that `install.sh` placed
  and that nothing has changed since, and `--check` reports without replacing.
- **The old `install.sh` environment variables on the Loom installer** (MMR-555).
  `MIMIR_INSTALL_DIR`, `MIMIR_VERSION`, and `MIMIR_NEXT` do nothing there; use
  `--dir`, the version argument, and `self-update --channel next`. The root
  `install.sh` keeps them for older versions.

### Migration

**Affected surface.** Scripts and installs that call `mimir self-update --next` or `--tag <tag>`, or that set `MIMIR_NEXT`, `MIMIR_INSTALL_DIR`, or `MIMIR_VERSION` for the Loom installer.

**Why.** Loom's installer and updater take channels, a version argument, and flags in place of environment variables.

**Before and after.**

```sh
mimir self-update --next
mimir self-update --tag 0.26.0-next.5
mimir self-update --channel next
mimir self-update 0.26.0-next.5
```

**Steps.**

1. Replace `--next` and `MIMIR_NEXT=1` with `--channel next`, and `--tag <tag>` with a version argument.
2. Pass `--dir <directory>` and a version argument to the Loom installer in place of `MIMIR_INSTALL_DIR`, `MIMIR_VERSION`, and `MIMIR_NEXT`; the root `install.sh` keeps them for older versions.
3. Run the Loom installer once on an existing install, as the "One reinstall after upgrading" entry describes, so `self-update` accepts it.

**Validation.** `mimir self-update --check` reports without replacing.
