---
title: 'ADR 0002: General-purpose primitives, not baked-in semantics'
status: accepted
date: 2026-06-03
---

# ADR 0002: General-purpose primitives, not baked-in semantics

Mimir does not encode any consumer's domain concepts. It exposes **general-purpose primitives** and lets each consumer (Saga today, possibly others, possibly a future evolved Saga) impose its own meaning:

1. **Tags** — flat, opaque strings attachable to **any work node or artifact** (tasks, phases, initiatives, projects, artifacts). The core does set-membership filtering (`has` / `lacks`, and/or) **composed with the structural scope filters** (`project`, `node`, `release`), and **never parses or interprets a tag**. Tags are "Mimir's frontmatter" — the work-side classification layer, agent-defined.
2. **No consumer/routine state** — no `routine_state` watermark, no `consolidated_at` column. _Process-once_ worklists (e.g. "unconsolidated") are **tag presence/absence**; _"since last check"_ is a **caller-supplied timestamp** compared against Mimir-owned transition times (see [ADR 0003](0003-append-only-transition-log.md)). The cursor lives in the consumer, never in Mimir.
3. **Artifact classification is tags, not a type enum** — `spec` / `plan` / `session_log` are just tags. Mimir has no artifact "types" (see [ADR 0004](0004-artifact-model-project-anchored-flexibly-linked.md)).

## Why

- **Boundary.** Mimir holds _work state_; "has consolidation read this log?" is _Saga's_ processing state. The moment Mimir owns a `consolidated_at` column or a `routine_state` table, it knows what consolidation _is_ — boundary breached.
- **Generality / longevity.** Keeping Mimir semantics-free means it is usable outside Saga, and Saga can evolve its conventions without a Mimir schema migration. The tool outlives any one consumer's workflow.
- **Flexibility over hand-holding.** Tag collisions, namespacing, and vocabulary are the **consumer's** concern. Every guardrail Mimir adds makes the tool more rigid; in a single-operator system the risk is low and convention covers it.
- **Scope is relational, not lexical.** "Belongs to the api work" is expressed by linking to a node and filtering `project = api AND has(tag)`, not by a `area:` prefix on the tag. Classification (tag) and scope (relation) are different concerns.

## Considered and rejected

- **Namespaced tag strings** (`saga:consolidated`, `area:api`) — smuggles _scope_ into a _classification_ primitive; scope is relational. A consumer may still self-namespace by convention, but the core neither mandates nor parses it.
- **`routine_state(name, last_run_at)` / `consolidated_at`** — consumer processing state stored in Mimir; replaced by tags (process-once) + caller cursors (temporal).
- **An artifact `type` enum** — forces a single classification convention and blocks multi/zero classification; dissolved into tags ([ADR 0004](0004-artifact-model-project-anchored-flexibly-linked.md)).
- **Core-enforced tag uniqueness / collision protection** — hand-holding that hardens the tool; cross-consumer collision on a bare tag is accepted as the consumer's concern.

## Consequences

- A general **tag** mechanism; taggable targets = any work node + artifact. The query layer composes tag predicates with the existing scope filters (`in_workspace`, `in_release`, by-node).
- The spec's §4.4 "transition predicates" dissolve: `unconsolidated` → a tag query; `recently_completed` / `newly_ready` → caller-cursor queries over transition times.
- MCP verbs genericize: `unconsolidated_logs` / `mark_consolidated` → generic `tag` / `list(lacks: …)`; the consolidation _naming_ moves to Saga.
- Artifact loses `type` and `consolidated_at` (see [ADR 0004](0004-artifact-model-project-anchored-flexibly-linked.md)).
