---
title: "ADR 0004: Artifact model — project-anchored, flexibly linked"
status: accepted
date: 2026-06-03
---

# ADR 0004: Artifact model — project-anchored, flexibly linked

An artifact is `{ id, project_id (required), content, created_at }` plus **0..N node links** and **tags**:

- **Anchored to exactly one `project`** (required) — its home, so even a zero-task session log is findable and "this project's artifacts" is one cheap query.
- **Links to 0..N work nodes** it touched (optional, finer context) via a join table. A session spanning several sibling tasks links them (or their common ancestor); a pure design session links none.
- **The required `task_id` FK is dropped.** An artifact need not relate to a task.
- **Classification is by tag** (no `type` enum — [ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)).
- **Session logs are found by tag + time, not by node** — so "relates to no task" is the normal case, not an exception.

## Why

- The spec assumed every artifact attaches to one task (`task_id` FK up). **Session logs proved otherwise:** a session is a bounded _episode_ that may touch many nodes, one, or none (a pure design/exploration session — like the one that produced these ADRs).
- **Specs/plans are _about a node_; a session is _about an episode_ that cuts across nodes.** Different shapes — forcing the episode into "owned by one task" is the error.
- The **project anchor** guarantees a home and a cheap project-scoped query; **0..N node links** carry the "what work this touched" context without being load-bearing for retrieval; the tree's **common ancestor** already answers "spans several sibling tasks."
- The consolidation worklist retrieves logs by **tag + time** (the `unconsolidated` tag), never via the tree — so a log needs no node link to do its job.

## Considered and rejected

- **Required single `task_id` FK** (spec §3.6) — forces a task that may not exist.
- **Polymorphic single-parent (any one node) only** — loses multi-touch context and still needs a home when there are zero links; the required `project_id` is the cleaner anchor.
- **Splitting `session_log` into a first-class cross-cutting "session" entity** (grouping axis, like release/workspace) — "session" is Saga's concept; one `artifact` table with flexible linkage is KISS. Promote only if "session" ever earns first-class status _in Mimir_.
- **Many-to-many with no required anchor** — artifacts could float, unfindable.

## Consequences

- `artifact` gains a required `project_id`; drops `type`, `consolidated_at`, and the NOT-NULL `task_id`.
- New `artifact_link(artifact_id, node_id)` join (0..N).
- `attach_artifact(project_id, content, node_ids?, tags?)`.
- **Multi-project artifacts deferred** — promote `project_id` to a join table only if a session ever provably spans projects (house style: start with the FK).
