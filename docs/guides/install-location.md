---
description: Choose an installation path, and how the first run binds an installation to its configuration, data, and cache directories.
---

# Install location

Install `mimir` with the repository's `install.sh`, which places the binary in
`~/.local/bin` by default. Choose another absolute directory with `--dir`:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/packages/cli/install.sh | sh -s -- --dir /opt/mimir/bin
```

Keep the binary on a local disk, not on a network volume.

The installer takes no environment variables. These retired variables map to
arguments:

| Retired | Now |
| --- | --- |
| `MIMIR_INSTALL_DIR=<dir>` | `--dir <dir>` |
| `MIMIR_VERSION=<tag>` | the version argument, such as `0.26.0` (a leading `v` is fine) |
| `MIMIR_NEXT=1` | the version argument, such as `0.26.0-next.5`; the installer never picks a prerelease on its own, so `mimir self-update --channel next` follows that channel afterward |

The installer verifies the download against the release's `SHA256SUMS`, writes
Loom's installation record (`install.json`, in the platform state directory),
and then runs `mimir mcp install --agent claude` to register the MCP server
with Claude Code. Pass `--skip-post-install` to skip the registration. Codex
is not registered: it cannot connect to Loom's MCP protocol revision yet.

## How the first run binds the installation

The installer records the binary's path and digest. It does not choose the
directories. The first run of a recorded binary registers its receipt,
`mimir.installation.json` beside the binary, which binds the executable path and
SHA-256 digest to Mimir's configuration, data, and cache directories. A copied
binary does not inherit this registration.

The first run adopts the installation only when every XDG root is HOME's
default: `$HOME/.config`, `$HOME/.local/share`, and `$HOME/.cache`, and outside
macOS `$HOME/.local/state`, where Loom's record lives. It prints one line naming
the directories it bound. When any XDG variable points elsewhere, the run adopts
nothing, names each variable, and uses the development directories beside the
binary. Unset the variables and run `mimir` once to adopt the defaults.

An installation that keeps its directories under custom XDG roots has no way to
adopt them on a fresh install. It needs a receipt from the earlier installer:
the receipt records those roots, and Loom's installer then upgrades it with them
kept. Reinstalling such a machine from scratch binds the `$HOME` defaults
instead, and the existing board stays where it is.

## Upgrade an earlier installation

Run the installer over the existing binary's directory (`--dir`). A registered
installation keeps its bindings: the next run sees that Loom's record names the
new digest and re-records the receipt with the same directories. Different
ambient XDG values do not redirect it. [Self-update](self-update.md) preserves
the same bindings.

An installation whose earlier self-update replaced the binary without
registering it has no receipt, and the new binary uses isolated development
directories instead of the existing board. If the board lives under the
`$HOME` defaults, run the installer and then `mimir` once, from an environment
with no XDG variables set. Otherwise it cannot be adopted; see the custom-roots
caveat above.

Verify with `mimir overview` from a bound repository.

## Repeat installation and relocation

At the same binary path, later installer runs validate the receipt and preserve
its bindings. To relocate the binary, run the installer with the new `--dir`; at
a new path without a receipt, the first run adopts it as a separate installation
under the rules above.

Do not copy a binary and its receipt to a new path. A receipt with a different
canonical path or executable digest fails validation before normal state access.
