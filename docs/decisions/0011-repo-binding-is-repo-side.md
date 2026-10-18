---
title: 0011 — Repo binding is repo-side; the store knows no filesystem paths
status: superseded
superseded_by: 'ADR 0036'
date: 2026-06-11
---

# 0011 — Repo binding is repo-side; the store knows no filesystem paths

> **Superseded (2026-10-18, MMR-543) by [ADR 0036](0036-project-binding-through-git-config.md).**
> The binding moves to git config, and projects store a Git remote. This record
> is kept for history.

A project's connection to a working copy lives in the **repo**, not the store. The node table's `repo`/`path` columns are **dropped** (table-rebuild migration, `MMR-44`). A repo declares its project in a checked-in **`.mimir.toml`** whose payload is a single line, `project = "KEY"`. The **binary owns the file**: `mimir bind <KEY>` writes it, and every command resolves it — walking up from cwd, **nearest file wins** — as the **default `-s` scope**; an explicit `-s` always overrides.

## Why

- **A stored path pins the project to one machine.** The store's data should survive a DB move, a re-clone, a second machine — caught during the `MMR-24` skill grooming as a design anomaly, not a feature.
- **The columns were write-only vestiges** — never rendered by the read surface, consumed by nothing. Removal costs zero behavior.
- **Checked in, the binding travels with the repo** — every clone is bound for free, which is exactly the portability the stored path destroyed.
- **The binding answers one question** — _which project does this working copy belong to?_ — and the immutable project key is the complete answer; it is literally what `-s` takes.
- **CLI-resolved default scope kills the per-invocation `-s` tax.** The common case is "in a repo, working its project" — agents and humans both just type `mimir next`. (Optimize the common case.)
- **Spine:** Mimir stores work-state facts; _where a working copy sits on some machine's disk_ is an environment fact.

## Considered and rejected

- **Store-side binding (look up cwd against `project.repo`/`path`)** — the store pointing at the filesystem is the root anomaly, not a mechanism to build on; non-portable by construction.
- **A DB path inside `.mimir.toml`** — _which store_ is an environment fact (`$XDG_DATA_HOME/mimir/mimir.db`, env/flag override), not a repo fact; checking in a DB path re-imports the machine-specificity just evicted.
- **Skill-only convention (binary ignorant of the file)** — keeps the binary filesystem-clean, but taxes every invocation with `-s` and makes each consumer reimplement resolution. One well-defined dotfile owned by the binary beats N consumers parsing it.

## Consequences

- Migration drops `repo`/`path`; `create project` loses `--repo`/`--path` (`MMR-44`).
- New surface: `bind` verb + nearest-wins resolution + default-scope semantics (`MMR-45`); the agent skill's init flow ends with `bind`, never hand-editing the file.
- **Both renderings honor it** — the MCP server resolves the same file from its spawn cwd, keeping the "no CLI-only verbs" rule honest.
- Monorepos: a sub-project's deeper `.mimir.toml` shadows the root one (standard nearest-wins dotfile semantics, nothing to spec).
