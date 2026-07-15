# Self-update

`mimir self-update [--next] [--tag <tag>]` replaces the running binary in
place and, if the `serve` unit is loaded, restarts it.

## Channels

- **Default (no flags)** — resolves the latest official (non-prerelease) tag
  via the `/releases/latest` redirect and installs it if newer.
- **`--next`** — resolves the newest release including prereleases (read from
  the releases atom feed, since GitHub's `/releases/latest` excludes
  prereleases) and installs it if newer.
- **`--tag <tag>`** — installs an exact tag (official or prerelease, e.g.
  `v0.6.0-next.5`), bypassing the "is it newer" check other than reporting
  "already up to date" if it matches the running version.

Already-current is a no-op that reports the current version and exits 0.

## Verification and replacement

The platform asset (`mimir-<darwin|linux>-<arm64|x64>`) and `SHA256SUMS` are
downloaded for the resolved tag; the asset's SHA-256 is checked against its
`SHA256SUMS` entry before anything is written. A mismatch aborts with no
replacement — "the download is corrupt or tampered with — not installed."
The swap itself is write-beside-then-rename (`<binary>.self-update` written
first, `chmod 755`, then renamed over the target) — atomic on the same
filesystem, so a crash mid-download never leaves a half-written binary in
place.

## Restart-if-loaded

After a successful replace, if the process is running on macOS and the
`serve` unit is currently loaded, self-update restarts it
(`launchctl kickstart -k`) so the new binary takes effect immediately. This
restart honors the same dev-build fence as the `service` verbs — from an
untrusted build it's skipped with a warning telling you to run
`mimir service restart` yourself (the binary is already updated at that
point regardless). A restart that fails for any other reason surfaces the
same way: the update itself always succeeds or fails independently of the
restart, and a stale-loaded daemon is never left silently.

`self-update` requires an installed binary — running from a `bun`-prefixed
executable (a dev/source invocation) refuses with a pointer to `git pull` /
`bun run` instead.

## Source

`packages/bin/src/service/self-update.ts` (resolve/verify/replace),
`commands.ts`'s `cmdSelfUpdate` (orchestration: version gate, restart, event
log).
