---
title: 'ADR 0005: The grouping (horizontal) axis is tags'
status: accepted
date: 2026-06-03
---

# ADR 0005: The grouping (horizontal) axis is tags

The two axes stay as a concept, but the **horizontal / grouping axis** (workspace, release, and any future cross-cutting grouping) is expressed **entirely through tags** ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md)), not first-class entities:

- **Vertical / work axis is unchanged** — `project → initiative → phase → task`, the tree that completes and rolls up via `parent_id`.
- **Horizontal groupings are tags.** `workspace:*` on projects, `release:*` on tasks — agent-defined conventions Mimir never interprets.
- Drop the `workspace` and `release` tables and the `project.workspace_id` / `task.release_id` FKs. `repo` / `path` stay on `project`.
- **Membership and rollup are tag-scoped queries** — a grouping's status is `interpret(distribution over the nodes tagged X)`, the same rollup over a different scope filter.
- **Grouping metadata is an artifact tagged into the grouping** (e.g. a `release-note` artifact carrying `release:v0.37`) — the artifact model ([ADR 0004](0004-artifact-model-project-anchored-flexibly-linked.md)) already provides the home. Deadlines, if ever added, attach to a **work item** (node), not a grouping.

## Why

- **Same principle as 0002:** a cross-cutting grouping is _exactly_ what a tag is. Baking workspace/release into the schema couples Mimir to consumer semantics it doesn't need; as tags they become implementation details of how a consumer uses Mimir.
- **The spec already computed their status as a scope-filtered rollup** (§4.3: "`in_release`/`in_workspace` are the same rollup query with a different scope filter"). So they never needed to be entities — swapping FK-scope for tag-scope removes the table with no loss to rollup.
- **Tags natively give the many-to-many the spec kept deferring** ("promote to a join table _if_ a project is ever in multiple workspaces / a task spans releases"). A project in two workspaces, a task in two releases — both just work, no migration.
- **The "tags carry no attributes" cost is already solved by the primitives:** grouping metadata lives in an artifact tagged into the grouping; deadlines live on work items. Nothing additional is needed.

## Considered and rejected

- **First-class `workspace`/`release` entities with FKs** (spec §3.2, "a first-class entity… not a loose string tag") — couples the schema to consumer semantics and needs eventual join tables for many-to-many. Superseded.
- **A thin attribute escape-hatch on grouping tags** (target/description on the tag) — unnecessary; a tagged artifact already holds grouping metadata.
- **Keeping `in_release` / `in_workspace` as _core_ predicates** — would force the core to _name_ a tag (violates 0002). They become generic tag-scoped queries; ergonomic `scope` params (e.g. `next_tasks(scope)`) are consumer/MCP sugar that compile to a tag filter.

## Consequences

- Drop the `workspace` and `release` tables; drop `project.workspace_id` and `task.release_id`. `repo`/`path` remain on `project`.
- **Supersedes the design spec's §3.1–3.2 grouping-axis treatment** and the "never a loose tag" rule; rewrites the glossary's **Grouping axis** / **Project** / **Task** entries.
- §4.3 scope predicates become tag-scoped queries; MCP `scope` sugar resolves to a tag filter, not an FK lookup.
- A future time-bound, roll-up-target release is an _additive_ change if it's ever genuinely needed — not complexity carried now.

## Refinement (2026-07-13, MMR-270): a tag application carries no note on any entity

Tags are a **plain string set** — a tag application carries **no note**, on nodes, projects, or artifacts alike. The per-tag `note` affordance is retired from the entire tag surface: the CLI `--note` flag, the MCP tool param, the HTTP tag-route body field, and the `note` on every tag record (write and read) are all removed.

The parameter had already ceased to mean anything. Vault `tags` frontmatter is a plain string set with nowhere to hold a note (the frontmatter model here and in the schema reference); once the Norn vault became the sole store, a node/project tag note was **silently dropped on write** — a successful write discarding caller data. The artifact seam made the same gap explicit by _rejecting_ a note outright (MMR-143). One contract everywhere is the honest shape: rather than a param that sometimes throws and sometimes vanishes, it doesn't exist.

**Note-intent routes to the tools that own it.** One-off rationale — why _this_ attachment — goes in `annotate` (about the task's work, append-only, outliving any tag). Grouping metadata that several entities share goes in a **tagged artifact** — the pattern this ADR already prescribes for grouping attributes ("grouping metadata is an artifact tagged into the grouping"). Neither ever needed to ride on the tag row.

This **supersedes the MMR-143 runtime-rejection posture**: with the parameter gone from the seam signature entirely, an artifact tag note is now structurally impossible rather than rejected at runtime — the rejection and its conformance test are removed.
