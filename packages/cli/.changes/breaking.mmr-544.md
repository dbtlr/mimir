- **Clones bind through git config** (MMR-544). A command that needs a default project now reads `mimir.project` from the clone's git config; an unbound clone matches its `origin` remote against project remotes and, on exactly one match, writes the binding to git config and prints one line naming the key and source. Several matches leave the clone unbound and say to run `mimir bind KEY`. Linked worktrees share the binding, and the MCP server resolves it from the directory it starts in. `mimir bind KEY` writes git config and records the clone's origin on a project with no remote; a bare `mimir bind` prints the bound key or exits non-zero with `unbound: run mimir bind KEY`. `.mimir.toml` is no longer read; `bind` notes when one is present and ignored. See [ADR 0036](../../docs/decisions/0036-project-binding-through-git-config.md).

### Migration

**Affected surface.** Clones that bind to a project through `.mimir.toml`.

**Why.** Binding through git config lets linked worktrees share one binding and lets an unbound clone bind itself from its `origin` remote.

**Before and after.**

```sh
# .mimir.toml names the project
mimir bind KEY
```

**Steps.**

1. Run `mimir bind KEY` in each clone; it writes `mimir.project` to git config and records the clone's origin on a project with no remote.
2. Remove the ignored `.mimir.toml`.

**Validation.** A bare `mimir bind` prints the bound key instead of exiting non-zero with `unbound: run mimir bind KEY`.
