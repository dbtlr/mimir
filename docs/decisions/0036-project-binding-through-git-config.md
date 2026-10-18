---
title: 'ADR 0036: A clone binds to its project through git config and the project remote'
description: A clone records its project in git config, an unbound clone finds it by matching its origin against project remotes, and a bare bind is the binding check. Project remotes are normalized and not unique.
status: accepted
date: 2026-10-18
---

# ADR 0036: A clone binds to its project through git config and the project remote

This supersedes [ADR 0011](0011-repo-binding-is-repo-side.md). ADR 0011 kept
the binding out of the store, in a checked-in `.mimir.toml`. That placement
made a binding a repository change: a PR, a merge, and a file every clone has
to carry. The binding is a fact about a clone, not about the code.

## The decision

### A clone binds through git config

A clone's project is the value of the `mimir.project` key in its git config.
Commands resolve it as the default project scope, and an explicit `-s` still
overrides it. The checked-in `.mimir.toml` is retired, and no Mimir code reads
it once the rollout in MMR-544 and MMR-545 lands.

### A project stores a Git remote

A project has a nullable `remote`. It holds the repository identity
`host/path`: the scheme, credentials, and port are dropped, the host is
lowercased, and a trailing `/` or `.git` is removed. The ssh and https forms of
one repository store the same value. The path keeps its case, because hosting
paths can be case-sensitive. A value that is not a Git remote is refused at
write time.

The remote is set with `create project --remote` and `update KEY --remote`
(MCP `create` and `update` and HTTP `POST` and `PATCH /api/projects` take
`remote`; a blank value means none, clearing it on update). The
transfer document carries it as version 5; an older document imports with no
remote.

### The remote is not unique

There is no unique constraint. Two projects may share a repository, such as a
monorepo split into projects. The Engine method `projectsByRemote` returns every
active project whose remote matches the given one, in key order, and the caller
decides what ambiguity means. A lookup value that is not a network remote, such
as a local-path or `file://` origin, matches nothing and returns an empty list
instead of an error; only writes refuse it. The auto-bind in MMR-544 binds only on exactly
one match; on several it leaves the clone unbound and tells the user to run
`mimir bind KEY`.

### An unbound clone finds its project from its origin

A clone with no `mimir.project` matches its `origin` remote against project
remotes through `projectsByRemote`, and writes the binding back to git config
when exactly one project matches. This work adds the field and the lookup;
nothing reads them for binding yet, so behavior is unchanged until MMR-544.

### A bare `bind` is the binding check

`mimir bind` with no key prints the clone's project and exits non-zero when the
clone is unbound. `mimir bind KEY` writes `mimir.project`.

## Why

- **The binding is per clone.** git config is local to a clone, so binding
  never lands in a PR or conflicts with another branch.
- **A remote identifies the project without a step.** Every fresh clone of a
  bound repository finds its project from its origin, which keeps ADR 0011's
  "every clone is bound for free" without a checked-in file.
- **Uniqueness would forbid real layouts.** A constraint turns a monorepo with
  several projects into a write error. Ambiguity at lookup is rare, visible,
  and recoverable with an explicit `bind`.
- **Normalization is the only reliable comparison.** Users clone by ssh or
  https and the forms differ in scheme, credentials, and `.git`.

## Considered and rejected

- **A non-git fallback.** A directory without git has no remote and no git
  config. Binding there would need a second mechanism, such as a dotfile, that
  rebuilds what this decision retires. Such a directory passes `-s`.
- **Subdirectory bindings.** Nearest-file-wins let a monorepo bind each
  subdirectory to its own project. git config is per repository, so this is
  not available. A monorepo passes `-s` for the other projects.
- **A unique remote.** See above.
- **Keeping `.mimir.toml` beside git config.** Two sources of truth need a
  precedence rule and leave the retired file readable forever.

## Consequences

- Migration `0006_project_remote` adds the nullable `project.remote` column;
  existing projects read without one. Transfer documents move to version 5.
- The store still knows no filesystem paths. A remote is a repository
  identity, not a location on a machine.
- ADR 0011 is superseded and kept for history.
