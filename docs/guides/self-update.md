---
description: Self-update channels, installation receipt preservation, replacement failures, and service restart behavior.
---

# Self-update

`mimir self-update [--next] [--tag <tag>]` replaces the running binary in
place. A registered installation keeps its configuration, data, and cache
directories. On macOS, a registered live installation also restarts its loaded
`serve` unit.

For an installation without a receipt, use the
[legacy installation transition](install-location.md#upgrade-an-installation-without-a-receipt)
first. Self-update does not create a missing receipt.

## Channels

- **Default (no flags)** resolves the latest official tag through the
  `/releases/latest` redirect and installs it if newer.
- **`--next`** selects the highest SemVer release from the releases atom feed,
  including prereleases, and installs it if newer.
- **`--tag <tag>`** selects an exact tag, including an older release, unless
  it matches the running version. The candidate must support installation
  protocol version 1.

Already-current is a no-op that reports the current version and exits 0.
Releases without installation protocol support cannot replace the binary
through this updater, even with `--tag`.

## Verification and replacement

Self-update downloads the platform asset and `SHA256SUMS` for the selected tag.
It verifies the asset's SHA-256 before replacement. A missing checksum entry
or a mismatch aborts the update.

The updater validates any existing receipt before it writes a candidate to
`<binary>.<uuid>.self-update`. It probes the candidate's installation protocol
with empty, isolated configuration. An incompatible candidate leaves the
installed binary and receipt unchanged.

After the probe, the updater renames the candidate over the canonical binary
path. A registered installation then receives a new receipt with the replacement
digest and the same bindings. The receipt uses
`<binary>.installation.json.<uuid>.tmp` before its own rename.

Each rename is atomic on the same filesystem. The binary and receipt updates
are separate operations, not one atomic transaction. An interruption between
them leaves a mismatched receipt, and subsequent normal commands refuse access
to the bound state. The installer also refuses a mismatched existing receipt.

After the candidate write, handled probe and replacement errors remove the
candidate file. Receipt-write cleanup also removes its temporary file. An abrupt
termination or an initial staging-write failure can leave temporary files behind.
Neither replacement mechanism automatically rolls back a binary after its rename.

## Restart-if-loaded

After replacement, self-update inspects the macOS `serve` unit. If the unit is
loaded and the binary has live installation authority, it restarts the unit
with `launchctl kickstart -k`.

Without live installation authority, the restart is skipped with a warning.
A restart failure also produces a warning. In both cases, the binary replacement
already succeeded. The `snapshot` unit uses the new binary on its next invocation.

Source invocations through a `bun`-prefixed executable refuse self-update.
An unregistered standalone binary can replace itself, but the replacement does
not gain installation authority.

The shell installer does not restart services. Its separate transition procedure
includes an explicit restart for an existing service.

## Source

[`self-update.ts`](../../packages/bin/src/service/self-update.ts) owns release
selection, checksum verification, and replacement.
[`commands.ts`](../../packages/bin/src/service/commands.ts) owns the version
gate, service restart, and event log.
