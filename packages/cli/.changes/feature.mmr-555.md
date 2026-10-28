- **A new installer** (MMR-555). The Loom installer lives at
  `packages/cli/install.sh` and installs Loom-built releases, 0.26.0-next
  prereleases and later; the root `install.sh` stays for older versions and is
  what the README fetches until the first stable Loom-built release. It verifies
  the download against the release's `SHA256SUMS`, records the installation in
  Loom's `install.json`, and then runs `mimir mcp install --agent claude` to
  register the MCP server with Claude Code. Flags replace the environment
  variables: `--dir <directory>` replaces `MIMIR_INSTALL_DIR`, and a version
  argument such as `0.26.0` or `0.26.0-next.5` replaces `MIMIR_VERSION` and
  `MIMIR_NEXT`. `--skip-post-install` skips the registration. Codex is not
  registered, because it cannot connect to this MCP revision yet. A `mimir` server
  you added to Claude Code by hand makes the registration fail; run `mimir mcp
  install --agent claude --force` once.
- **One reinstall after upgrading** (MMR-555). An old binary's `self-update`
  replaces the binary but writes no Loom installation record, so the new binary's
  `self-update` refuses it as installed some other way. Run the Loom installer once
  with the install's directory and a Loom-built version: `curl -fsSL
  https://raw.githubusercontent.com/dbtlr/mimir/main/packages/cli/install.sh | sh -s
  -- --dir <dir> <version>`. It writes the record and keeps the receipt's directories.
- **First run binds the installation** (MMR-555). The installer records the
  binary, and its first run registers the receipt that binds the configuration,
  data, and cache directories, only when every XDG root is HOME's default. A
  machine whose directories sit under custom XDG roots can keep them only through
  a receipt the earlier installer already wrote; a fresh install there adopts
  nothing, prints the variables to unset, and uses the development directories
  beside the binary. The first run is the installer's own post-install command,
  so the adoption line appears during the install.
