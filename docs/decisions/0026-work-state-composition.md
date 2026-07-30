---
title: 'ADR 0026: Work-state composition — views are composed at read time, never written into knowledge documents'
status: accepted
date: 2026-07-30
---

# ADR 0026: Work-state composition

Agent workflows around Mimir maintain per-project knowledge documents (briefs)
whose work-state sections — current state, what's next, recent sessions — are
hand-rolled rollups over the board. A 30-day survey of one such document set
measured the cost: the highest-churn briefs were re-authored at nearly every
session boundary (80–119 edits/30d each), each edit deleting and rewriting
whole narrative paragraphs to restate mostly-unchanged facts; a single shipped
task's outcome landed in five places (session log, two brief sections, a
changelog fragment, task annotations); and every observed drift incident traced
to a brief whose rollup tax went unpaid. This is the substrate mismatch Mimir
was founded on, resurfacing one layer up: a hand-maintained work-state section
is a cached rollup, and a cached rollup is itself a sync surface (ADR 0001).

The shape was settled in the MMR-318 arc (design-of-record: artifact MMR-a60);
this ADR records the decision rules.

**Decision 1 — composition over synchronization.** Work state is composed into
views at read time; it is never written into knowledge documents. Session
primers and orientation surfaces assemble durable prose from the knowledge
side and live state from `mimir overview` — same document for the reader,
different provenance per section. Knowledge documents carry no work-state
sections, not even a pointer that re-narrates the queue. The bar this raises
is completeness: once the prose fallback is removed, anything Mimir cannot
express is lost — hence Decisions 2–4, which add the three surfaces briefs
carried that Mimir could not.

**Decision 2 — "next" is derived; direction is owned prose.** There is no
`next` flag: what to work on next is ready ∩ rank, already derived (ADR 0007
rank primacy is unchanged). The non-derivable residue — direction-level
narrative above task granularity — gets an owned `## Next` body section on
project and container docs, maintained by a replace-section verb with
**replace-not-append semantics**: re-authored whole against the current board,
riding the guarded CAS write path. On conflict the writer re-reads and merges;
it never replays a stale draft. Replace semantics is the load-bearing choice:
append grain is what made brief sections grow monotonically, and an editorial
statement replaced whole has no rollup to drift.

**Decision 3 — in-flight metadata is resume handles, never telemetry.** Tasks
gain four optional update-plane string fields — `host`, `harness`, `session`,
`branch` — answering three forensic questions: what is happening, what did
happen, how do I continue. `start` sets them via flags; resume or takeover is
a plain `update` overwrite. There is deliberately **no claim verb**:
`in_progress` already is the claim, `start`'s CAS-guarded `todo→in_progress`
assert already makes claiming atomic for concurrent agents, and a cooperative
single-operator system needs no lock manager. Lifecycle verbs clear the fields
on terminal transitions and holds and keep them through `under_review` (the
branch and session remain the live pointers at the human gate); transition-log
rows echo them at boundaries, so history preserves claim succession. The
boundary rule: anything recoverable *from* the session — model, durations,
token counts — stays out. Mimir stores the keys into richer stores; mining
happens there. Mimir makes no liveness claims; consumers judge via the
handles, with the stale predicate as the coarse backstop. PR linkage rides the
existing `external_ref`.

**Decision 4 — session summaries are Mimir artifacts.** The retrospective of
work done in a session is work state: a `session_summary`-tagged artifact
anchored to the tasks the session touched (restoring the founding intent that
session records are frozen, queryable, task-attached). Artifacts gain an
optional `summary` lede field (mirroring the node lede) to power list views.
The raw transcript stays with the harness — the artifact is a retrospective,
not a log, which is why the `session_log` tag convention is renamed. The
recent-sessions view derives its mechanical layer from transition-log rows
grouped by session id and joins the top-N summary ledes over it; `overview`
(the ADR 0024 composite orientation surface) is its home, alongside
needs-attention listings promoted from hygiene counts.

**Consequences.** A vault schema bump (artifact `summary`, task handle
fields); a first body-prose surface on project/container docs; an expanded
`overview` and a cross-project artifact query; the session lifecycle re-plumbs
into independently-invocable finishing steps (transition / groom-next /
summarize), and dependent tooling migrates off brief-side work-state sections
only after the replacement surfaces ship. The trade accepted: owned `## Next`
prose is stored agent-authored state inside Mimir — justified because it is
not derivable and its replace-whole grain leaves nothing to drift; the
rejected alternatives (a pointer section, a `next` flag, a claim verb, stored
telemetry) each reintroduced a sync surface or a second ordering authority.
