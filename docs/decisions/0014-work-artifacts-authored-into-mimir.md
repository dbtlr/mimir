---
title: "ADR 0014: Work artifacts are authored into Mimir, not the vault filesystem"
status: accepted
date: 2026-06-16
---

# ADR 0014: Work artifacts are authored into Mimir, not the vault filesystem

Where session logs, specs, and plans physically live, and who writes them.
[ADR 0004](0004-artifact-model-project-anchored-flexibly-linked.md) made an
artifact a project-anchored, queryable record and admitted the node-less
session log. This completes that thought: the artifact in Mimir is the **only**
copy — the parallel markdown file in the vault is retired.

## The decision

1. **Work artifacts are written directly into Mimir** as project-anchored
   artifacts via the existing `attach` surface — `linkNodeIds` optional, so a
   node-less session log is the normal case (ADR 0004). The vault filesystem is
   no longer an artifact store. "Work artifacts" = the agent-authored records of
   work: **session logs, specs, plans.**

2. **Fix it at the write, not with a reader.** The agent that authors a log
   (today, the session-logging skill) stops emitting markdown to
   `artifacts/session-logs/` and instead attaches the content to Mimir
   (`attach --project <KEY> --title … --tag session-log`, body via file/stdin).
   No file is written.

3. **Mimir gains nothing — no import tool, no migration.** `attach` already
   carries title, content, project, and tags across every transport. Because the
   file-writer stops, there is nothing to keep importing: a one-way cutover, not
   an ongoing sync. An importer would be the wrong shape — it presumes a standing
   file→store gap that this decision closes at the source.

4. **Boundary: work artifacts only.** Durable **knowledge** — the Workspace
   Brief, glossary, `decisions/`, User Profile, Shared Memory — stays vault-side
   as Active Context. That is the founding distinction (knowledge in the vault;
   work state in Mimir); session logs are frozen _work records_ and cross the
   line into Mimir, while knowledge read by a human in Obsidian and loaded at
   session start does not.

5. **History is a one-time backfill.** Existing vault session logs whose
   `workspace:` frontmatter maps to a Mimir project are attached once via plain
   `attach`, then the source files retired. This is operational, not shipped
   code.

## Why

- **The dual substrate was the disease.** A log written as a vault file _and_
  mirrored as a Mimir record is two copies with no owner — exactly the
  status-sync/hygiene-drift failure Mimir exists to remove. Deleting the
  file-write eliminates the redundancy at its source; adding an importer would
  institutionalize it.
- **An importer encodes the wrong model.** It treats the filesystem as a
  permanent upstream to be polled. The filesystem was only ever the writer's
  default sink; redirect the writer and the "import problem" ceases to exist.

## Consequences

- **Lose:** plain-file portability and Obsidian-native reading/linking of logs.
  The Brief's relative-path links into `artifacts/session-logs/` break and must
  resolve to artifact ids (`KEY-aN`) or be dropped.
- **Gain:** one source of truth for work artifacts, queryable via `/artifacts`
  and the CLI; no dual-write; no drift.
- **Rollout is Mimir-first.** Full realization needs each workspace to own a
  Mimir project (the cross-workspace dogfooding thread); a workspace whose logs
  have no Mimir project keeps writing files until it binds one.
- The legacy `Log/` corpus (other tools' Feb–May history, no Mimir-workspace
  logs) is out of scope until those tools bind Mimir projects.
