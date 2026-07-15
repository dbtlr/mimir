# Install location

Install `mimir` to `~/.local/bin` — the `install.sh` default (override with
`MIMIR_INSTALL_DIR`) — and let launchd run it from there. Don't put the
binary on a network or external volume.

## Why: launchd can't dyld-link a binary off a `noowners` mount

A volume mounted with `noowners` (the default for many network shares and
some external-disk setups on macOS, e.g. under `/Volumes`) reports every file
as owned by the mounting user regardless of actual on-disk ownership. A
process launched interactively from a login shell tolerates this fine. A
process launched by `launchd` — which is what runs the installed `serve` and
`snapshot` units — does not: dynamic linking a binary that lives on an
`apfs`-formatted `noowners` mount fails when launchd starts it, even though
running the same binary by hand from a Terminal works. The failure mode is
confusing precisely because the interactive case masks it.

`~/.local/bin` sits on the boot volume, which never has this problem — it's
the only location that's been exercised as a real install target, and the
one `install.sh` and `mimir setup` assume.

## In short

- Real installs: `~/.local/bin/mimir` (or another path on the boot volume).
- Don't install to a `/Volumes/...` mount and point the launchd plist at it —
  it will fail to load, and the reason won't be obvious from the error.
- If you need to relocate the binary, `MIMIR_INSTALL_DIR` at install time is
  the supported way; the plist's `ProgramArguments[0]` is whatever path was
  installed at, baked in at `service install` time.
