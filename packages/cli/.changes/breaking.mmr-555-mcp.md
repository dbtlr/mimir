- **The CLI and MCP server run on Loom** (MMR-555). The `mimir` binary is now
  built from `packages/cli` with `loom build --release`, and the old hand-rolled
  CLI and MCP SDK server are gone. Commands, flags, and exit codes change in the
  ways the entries below list. `mimir mcp` serves MCP protocol revision
  2026-07-28 only, so older MCP clients cannot connect, and an existing Codex
  registration of mimir stops working until Codex supports that protocol
  (tracked upstream as LM-s39).
- **MCP tool names and inputs follow the commands** (MMR-555). A tool is named for
  its command path joined with `_` (`create_task`, `scratch_checkpoint`), and its
  inputs are the command's arguments and options by their kebab-case names
  (`worker-session`, `at-or-before`). A board read takes `scope` or the project
  the server's directory is bound to, and has no `all`. The `mimir` skill lists
  the verbs and flags; install it again with `mimir skills install`.

### Migration

**Affected surface.** MCP clients that connect to `mimir mcp`, the Codex registration of mimir, and callers of the old tool names and inputs.

**Why.** The MCP server now runs on Loom's MCP plugin, which serves MCP protocol revision 2026-07-28 only and names each tool for its command.

**Before and after.**

```sh
mimir skill install
mimir skills install
```

**Steps.**

1. Use an MCP client that supports protocol revision 2026-07-28; Codex stops working until it does (LM-s39).
2. Rename tool calls to the command path joined with `_` (`create_task`, `scratch_checkpoint`) and pass the command's kebab-case arguments and options (`worker-session`, `at-or-before`).
3. Pass `scope`, or run the server from a bound directory, for a board read; `all` is gone.
4. Install the `mimir` skill again with `mimir skills install`.

**Validation.** The client connects to `mimir mcp`, and a tool call such as `create_task` succeeds.
