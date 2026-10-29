---
description: Self-update channels, installation receipt preservation, and replacement failures.
---

# Self-update

`mimir self-update [<version>] [--channel <channel>] [--check]` replaces the
running binary in place, using Loom's self-update. A registered installation
keeps its configuration, data, and cache directories.

Self-update replaces only a binary that `install.sh` placed and nothing has
changed since: it compares the binary with Loom's installation record
(`install.json`) before it asks the network anything. A binary installed some
other way, a copy, or a binary whose bytes changed is refused with the command
that reinstalls it. Self-update does not create a missing record; run
[`install.sh`](install-location.md) first. That installer installs Loom-built
releases (0.26.0-next prereleases from the cutover on, and 0.26.0 and later).

An installation upgraded by an old binary's self-update has no Loom record. Run the
Loom installer once with `--dir <dir> <version>`, as
[Install location](install-location.md#upgrade-an-earlier-installation) shows.

## Channels

- **Default (no arguments)** resolves the latest release on the running
  binary's own channel: a stable binary follows the latest official release, a
  prerelease binary follows `next`. It installs the release only if it is newer.
- **`--channel next`** follows the highest SemVer release from the releases
  feed, prereleases included, and installs it if newer. `--channel stable`
  returns to official releases.
- **`<version>`** selects an exact release, such as `0.26.0` or
  `0.26.0-next.5`, newer or older, unless it equals the running version. It
  cannot be combined with `--channel`.
- **`--check`** reports what an update would do and replaces nothing.

Already-current is a no-op that reports the current version and exits 0. The
earlier `--next` and `--tag <tag>` spellings are refused with the replacement
named.

## Verification and replacement

Self-update downloads the platform asset and `SHA256SUMS` for the selected
release and verifies the asset's SHA-256 before replacement. A missing
checksum entry or a mismatch aborts the update. The verified bytes go to a
staging file beside the binary and are renamed over it, so a running copy keeps
running, and Loom's record is rewritten with the new digest.

The next run of the new binary sees that Loom's record names the new digest and
re-records Mimir's receipt with the same bindings. An interruption between the
rename and the record leaves a mismatch, and the next run refuses until
`install.sh` installs again.

## Where self-update applies

Source invocations through a `bun`-prefixed executable and development builds
refuse self-update, because they are not release binaries.

Self-update replaces the CLI binary only. The host container updates by image
tag: see [Upgrade the host](host.md#upgrade-the-host-and-the-clis-that-share-its-postgres).
