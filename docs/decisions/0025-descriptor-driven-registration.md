---
title: 'ADR 0025: Descriptor-driven registration — facts in tables, grammar in views'
status: accepted
date: 2026-07-18
---

# ADR 0025: Descriptor-driven registration

The two dominant change vectors fan out mechanically across the codebase.
Adding one uniform lifecycle verb (`reopen`) cost ~90 source lines, ~46 of
them spread across six transport files restating the same few facts — verb
name, accepted id-kind, reason optionality, state transition — once per
transport in a different syntax. Adding one scalar field (`upstream`) restated one domain fact at
roughly 24 non-test sites, including the `decodeNode`/`nodeFrontmatter`
inverse pair, which is synchronized today by nothing but a doc comment: a
missing decode entry compiles clean, passes the suite, and produces a field
that writes to frontmatter but never reads back — a silent data bug. Four
hand-maintained per-field tables already exist (`QUERY_FIELDS`,
`UPDATE_FIELD_ORDER`/`APPLICABLE_UPDATE_FIELDS`, `UPDATE_FIELD_FLAGS`),
each carrying a slice of the same vocabulary.

The MMR-303–306 slate moved semantic validation into the core, making the
residual fan-out purely a registration problem. The shape was settled at
MMR-310 (design-of-record: artifact MMR-a59); this ADR records the decision
rules. The governing metric is **per-change reconciliation cost**, not change
frequency: every field or verb change pays the fan-out tax, and each
restatement site is a place a diff can land incomplete.

**Decision 1 — field planes: the data plane goes through one spec; structure
stays bespoke.** Every updatable and/or queryable scalar fact on a work node
is declared exactly once, in a field-spec table (a `Record` over the
field-key union). From that one entry derive: both codec directions
(frontmatter decode and emit — the inverse pair ceases to exist as a pair),
update applicability gates, the query registry, and the transport schemas.
The identity/topology plane — id, type, parent, rank, tags, the transition
log — never goes through the spec: those are not facts _on_ a node but what
makes it a node in the graph; they have their own verbs, and their decode is
inherent structural work. (These field planes are unrelated to ADR 0024's
command planes; the overload is acknowledged and the glossary disambiguates.)

**Decision 2 — kinds are where code lives; fields are pure data.** A field
declares a **kind** (`seed-ref`, `enum:priority`, `date`, …); the kind names
the parser/emitter pair, the schema fragment, and the query semantics.
Adding a field with an existing kind is a one-entry data change; only a
genuinely new value shape adds code.

**Decision 3 — one router, many grammars.** The twelve uniform verbs (six
lifecycle, four hold, `archive`/`unarchive` — the "subject id + optional
reason" shape) register in one **operation registry** owning the dispatch
facts: subject id-kind, reason policy, state transition, canonical summary,
and the core binding. Transports derive their surfaces by iterating the
registry — the CLI's twelve switch arms collapse to one generic arm, MCP
registrations and HTTP routes loop-generate — while each keeps its own
invocation grammar (CLI positionals, REST paths). The twenty-nine
non-uniform verbs stay bespoke: one way for the uniform job, not one way
forced onto every job. Pure fact tables live in the contract package so any
consumer (including the UI) can read them; kind code and `run` bindings live
in the core.

**Decision 4 — core emits facts; views own templates; strict derivation.**
The registry carries no per-transport strings, and transports carry no
facts. All rendered text — CLI help and echo lines, MCP tool descriptions —
is a per-transport template over registry facts, so richness is derived from
structure rather than hand-authored per verb. No per-transport override
fields in v1. A new spec knob must serve at least two consumers; otherwise
it belongs in a view template.

**Alternatives rejected.**

- _Full generic verb rendering_ — a descriptor covering CLI grammar, REST
  paths, and LLM-facing prose for all verbs is the transports relocated into
  configuration; only 12 of 41 verbs even fit a uniform shape.
- _Code generation_ — a build step to maintain, when the runtime
  `Record`-over-union idiom already gives compile-error completeness
  (proven at MMR-306).
- _Per-transport prose overrides in the registry_ — the top of the
  config-blob slope; drift re-enters through the override. Adding one later,
  against evidence, is a small change; starting with them is not.

**Consequences.** Adding a field with an existing kind is one spec entry and
it surfaces on every transport; the decode/encode drift class becomes
structurally impossible; adding a uniform verb is one registry entry plus
one core mutation. Rendered prose becomes generated, so migration reviews
all text as golden diffs, and the codec swap must prove behavior
preservation by round-trip comparison against a representative vault
snapshot. Implementation: MMR-314 (field spec + kind registry + codec),
MMR-315 (transport derivation for fields), MMR-316 (operation registry).

Glossary updated: **field planes** (data vs. structure), **field kind**,
**operation registry**, **uniform verb**, **view template**.
