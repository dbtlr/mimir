---
description: Choose an installation path and register a legacy installation while preserving its existing configuration and board.
---

# Install location

Install `mimir` to `~/.local/bin`, the `install.sh` default. To select another
directory, set `MIMIR_INSTALL_DIR` when you run the installer.

On macOS, use a path on the boot volume. A launchd process cannot reliably load
the binary from a `noowners` volume, including some external and network mounts.
An interactive shell can hide this problem because the same binary runs there.

The installer places a receipt beside the canonical binary path:
`mimir.installation.json`. The receipt binds the executable path and SHA-256
digest to Mimir's configuration, data, and cache directories. A copied binary
does not inherit this registration.

## Upgrade an installation without a receipt

Use the current `install.sh` to replace a release that predates installation
receipts. An old binary's self-update command can replace the executable without
registering the replacement. The new binary then uses isolated development
directories instead of the existing board.

1. Identify the existing binary path with `command -v mimir`.
2. Preserve the `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` values
   used by the existing installation.
3. Download the current installer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh -o install.sh
   ```

4. Select a candidate with installation protocol version 1 before you run the installer.

   If the latest official release predates receipts, select a compatible prerelease
   with `MIMIR_VERSION=<tag>` or `MIMIR_NEXT=1`.

5. Run the installer with the same target directory and XDG roots.

   For the default paths:

   ```sh
   sh install.sh
   ```

   To select a compatible prerelease at the default paths:

   ```sh
   MIMIR_VERSION="<compatible-tag>" sh install.sh
   ```

   Or, to select the newest release-feed entry:

   ```sh
   MIMIR_NEXT=1 sh install.sh
   ```

   For custom paths, substitute the existing values in this example.
   If you need a prerelease, add its selection variable before `sh install.sh`.

   ```sh
   MIMIR_INSTALL_DIR="/path/to/bin" \
   XDG_CONFIG_HOME="/path/to/config-root" \
   XDG_DATA_HOME="/path/to/data-root" \
   XDG_CACHE_HOME="/path/to/cache-root" \
   sh install.sh
   ```

6. Verify that `mimir.installation.json` exists beside the installed binary.
7. From a bound repository, run `mimir overview` to verify the expected board.
8. If the service was running, run `mimir service restart`.

The XDG values are roots: the installer appends `/mimir` to each one. Unset roots
default to `$HOME/.config`, `$HOME/.local/share`, and `$HOME/.cache`, respectively.
The first registration cannot recover previous custom roots from an absent
receipt. It records the values supplied to that installer invocation.

The installer selects the latest official release by default. `MIMIR_NEXT=1`
selects the newest release-feed entry, and `MIMIR_VERSION=<tag>` selects an exact
release. The selected candidate must support installation protocol version 1.
An older candidate is refused before replacement.

Registration preserves the configuration file, board, and caches at those paths.
The transition does not require `mimir setup`, a board reset, or a data import.
The shell installer does not restart an existing service.

## Repeat installation and relocation

At the same binary path, later installer runs validate the receipt and preserve
its bindings. Different ambient XDG values do not redirect an existing registered
installation. [Self-update](self-update.md) preserves the same bindings.

To relocate the binary, run the installer with the new `MIMIR_INSTALL_DIR` and
the existing XDG roots. At a new target path without a receipt, the installer
creates a separate registration. If you use launchd, run `mimir service install`
through the new binary to update the `serve` unit's executable path. If the
`snapshot` unit is also installed, run `mimir service install snapshot` through
the new binary to update that unit too.

Do not copy a binary and its receipt to a new path. A receipt with a different
canonical path or executable digest fails validation before normal state access.
