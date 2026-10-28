---
description: Choose an installation path, and how the first run binds an installation to its configuration, data, and cache directories.
---

# Install location

Two installers exist while the Loom CLI rolls out:

- **`install.sh` at the repository root** installs releases built from the old
  CLI (0.25.0 and earlier). It reads `MIMIR_INSTALL_DIR`, `MIMIR_VERSION`, and
  `MIMIR_NEXT`. It is what the README fetches until the first stable release
  built from the Loom CLI, and what you need to install an older version.
- **`packages/cli/install.sh`** installs Loom-built releases: the
  0.26.0-next prereleases from this cutover on, and 0.26.0 and later. Pointing it
  at an older version installs a binary that does not understand its
  post-install step, so use the root installer for those.

The rest of this guide describes the Loom installer, which places the binary in
`~/.local/bin` by default. Choose another absolute directory with `--dir`, and
pin a release with a version argument (it never picks a prerelease on its own):

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/packages/cli/install.sh | sh -s -- --dir /opt/mimir/bin 0.26.0-next.5
```

Keep the binary on a local disk, not on a network volume.

The Loom installer takes no environment variables. These variables of the root
installer map to arguments:

| Root installer | Loom installer |
| --- | --- |
| `MIMIR_INSTALL_DIR=<dir>` | `--dir <dir>` |
| `MIMIR_VERSION=<tag>` | the version argument, such as `0.26.0` (a leading `v` is fine) |
| `MIMIR_NEXT=1` | the version argument, such as `0.26.0-next.5`; `mimir self-update --channel next` follows that channel afterward |

The installer verifies the download against the release's `SHA256SUMS`, writes
Loom's installation record (`install.json`, in the platform state directory),
and then runs `mimir mcp install --agent claude` to register the MCP server
with Claude Code. Pass `--skip-post-install` to skip the registration. If you
added a `mimir` server to Claude Code by hand, the registration fails; run
`mimir mcp install --agent claude --force` once. Codex is not registered: it
cannot connect to Loom's MCP protocol revision yet, and an existing Codex
registration of mimir stops working until it can.

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
binary. To adopt the defaults, unset the variables, rerun the Loom installer so
its record moves under the default state root, and then run `mimir` once.

An installation that keeps its directories under custom XDG roots has no way to
adopt them on a fresh install. It needs a receipt from the earlier installer:
the receipt records those roots, and Loom's installer then upgrades it with them
kept. Reinstalling such a machine from scratch binds the `$HOME` defaults
instead, and the existing board stays where it is.

## Upgrade an earlier installation

An installation made by the root installer keeps its configuration, data, and
cache directories through the upgrade. Self-update from an old binary replaces it
with a Loom-built release and refreshes the receipt, but writes no Loom
installation record, so the new binary's own `self-update` refuses ("installed
some other way"). Run the Loom installer once, with the install's directory and
a Loom-built version:

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/packages/cli/install.sh | sh -s -- --dir <dir> <version>
```

`<dir>` is the directory that holds `mimir` (`dirname "$(command -v mimir)"`),
and `<version>` is a Loom-built release such as `0.26.0-next.5`. The installer
writes `install.json`; the next run sees that Loom's record names the new digest
and re-records the receipt with the same directories. Different ambient XDG values
do not redirect it. [Self-update](self-update.md) preserves the same bindings.

An installation whose old self-update replaced the binary without registering it
has no receipt, and the new binary uses isolated development directories instead
of the existing board. If the board lives under the `$HOME` defaults, run the
Loom installer and then `mimir` once, from an environment with no XDG variables
set. Otherwise it cannot be adopted; see the custom-roots caveat above.

Verify with `mimir overview` from a bound repository.

## Repeat installation and relocation

At the same binary path, later installer runs validate the receipt and preserve
its bindings. To relocate the binary, run the installer with the new `--dir`; at
a new path without a receipt, the first run adopts it as a separate installation
under the rules above.

Do not copy a binary and its receipt to a new path. A receipt with a different
canonical path or executable digest fails validation before normal state access.
