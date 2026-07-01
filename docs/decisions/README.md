# Architecture Decision Records

Decisions that shape Mimir's data model and surfaces, in the [Nygard ADR
convention](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
each record states the decision, the reasoning, the alternatives rejected, and
the consequences. Records are append-only — a superseding decision gets a new
number; refinements are dated sections appended to the original.

The through-line ("the spine") running through all of them: **Mimir stores
work-state facts and general-purpose primitives, never derived state or a
consumer's semantics.** When a question reaches for a bespoke column or
entity, prefer a general primitive plus a derivation.

Some records cite "the design spec" — the project's pre-implementation
internal design document. It is historical; these ADRs supersede it wherever
they conflict. References to **Norn** and **Saga** are sibling projects in the
same toolset (knowledge store and session orchestration, respectively); Norn's
dogfooded CLI conventions are prior art that ADR 0009 adopts.

| ADR                                                               | Decision                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| [0001](0001-task-status-two-axes-derived-rollup.md)               | Task status — two axes, derived readiness, distribution rollup |
| [0002](0002-general-purpose-primitives-not-baked-in-semantics.md) | General-purpose primitives, not baked-in semantics             |
| [0003](0003-append-only-transition-log.md)                        | Append-only transition log                                     |
| [0004](0004-artifact-model-project-anchored-flexibly-linked.md)   | Artifacts — project-anchored, flexibly linked                  |
| [0005](0005-grouping-axis-is-tags.md)                             | The grouping axis is tags                                      |
| [0006](0006-human-readable-node-ids.md)                           | Human-readable node ids                                        |
| [0007](0007-rank-is-primary-order-priority-is-signal.md)          | Rank is the primary order; priority is a signal                |
| [0008](0008-state-word-projection-and-interpret-cascade.md)       | Status-word projection and the `interpret` cascade             |
| [0009](0009-adopt-norn-output-and-selection-contract.md)          | Adopt Norn's output + selection/projection contract            |
| [0010](0010-one-binary-transport-only-consumption.md)             | One binary; transport-only consumption                         |
| [0011](0011-repo-binding-is-repo-side.md)                         | Repo binding is repo-side; the store knows no paths            |
| [0012](0012-http-api-true-resource-envelope.md)                   | The HTTP API is a true resource envelope                       |
| [0013](0013-ui-embedded-spa.md)                                   | The UI is an embedded SPA — board-first console, PWA           |
| [0014](0014-work-artifacts-authored-into-mimir.md)                | Work artifacts are authored into Mimir, not the vault          |
| [0015](0015-project-archive-frozen-and-hidden.md)                 | Project archive — a frozen, hidden, reversible project state   |

Two maintained engineering references live beside this directory:
[`docs/schema-reference.md`](../schema-reference.md) (the concrete SQLite
schema implied by ADRs 0001–0007) and
[`docs/output-contract-reference.md`](../output-contract-reference.md) (the
CLI/MCP output and selection contract bound by ADR 0009).
