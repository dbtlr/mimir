---
title: "ADR 0009: Adopt Norn's CLI output + selection/projection contract for the intent envelope"
status: accepted
date: 2026-06-04
---

# ADR 0009: Adopt Norn's CLI output + selection/projection contract for the intent envelope

Mimir's **intent envelope** (glossary **Envelope** — the CLI + MCP renderings) adopts the output and selection contract Norn already converged on over many iterations, rather than re-deriving one. Sources: Norn's CLI output spec and its find/get unified-output-contract spec (internal documents of the sibling project). This ADR records the adoption and the Mimir-specific bindings.

## What is adopted

1. **Selection vs. projection — the load-bearing split.** Commands differ in exactly one axis: _how they identify_ the rows to return. Everything downstream of selection is **one shared output contract** (projection vocabulary, formats, sort/limit/paging). The boundary is at _selection_, never at _projection_ — Norn explicitly tried "broad query projects lightly / targeted inspects fully" and found it wrong.
   - **Predicate selection** (broad set): `next` / `list` — `ready` + rank order, `stale`, `blocked`, scope/tag filters.
   - **Identity selection** (targeted): `get <id>…` — by node ID.
   - **Identical capabilities, selection-appropriate _defaults_:** broad selection defaults to a lean projection + a `--limit` guard; targeted defaults to the full record + no limit. This retires any "compact list DTO vs. full detail DTO" framing — there is one projection with two defaults.

2. **Five formats, with a two-layer split.** _Layout style_ — the styled TTY formats `records` + `table` (colors, icons, spacing) — is **evolvable and never parsed**; the _output contract_ (`ids`/`json`/`jsonl`) is a **versioned promise** to scripts and agents. Keep them mentally separate.
   - `records` — detailed single-node view. Bold `id` header + aligned `label  value` field rows (Norn §4.3). **TTY default for `get`.** Not a parse contract.
   - `table` — multi-row, colored, with **icons highlighting `state`** (and kindred signals); one task per line, scannable in rank order. **TTY default for set views** (`next`/`list`) — a queue scans better as rows than stacked blocks (Norn anticipated this: its §8 reserves `table` as a distinct format, never the `records` default). Not a parse contract. The state **word** is always present in-row; color/icon only _highlight_, so NO_COLOR/`--ascii` lose nothing (Norn's "color is decoration, never information").
   - `ids` — pipe default; one `KEY-seq` per line, no color, no wrapper. **Stable.** (Mimir's binding of Norn's `paths` — a task's identity is an **ID**, not a file path.)
   - `json` — one-shot; a tight wrapper `{ total, returned, starts_at, <unit>: [ … ] }` (the array key named after the unit, e.g. `tasks`). **Stable, versioned.** Nothing derivable in the wrapper (`truncated = returned < total`).
   - `jsonl` — streaming; one object per line, no wrapper. **Stable.**
   - Structured formats (`ids`/`json`/`jsonl`) **never** emit ANSI. Default follows destination **and view kind**: TTY → `table` for a set, `records` for a single node; pipe → `ids`. `--format` overrides. Set-returning commands **lead with a count**.

3. **Projection vocabulary** — one `--col` model on every selection front-end: **bare tokens** = scalar fields; **`.`-prefixed tokens** = structural facets (the dot disambiguates a field named like a facet). A broad "full structured dump" modifier (`--all-cols`) excludes the heavy disk/expensive facet. Requesting a heavy facet self-loads it.

4. **Help tiers — `-h` vs `--help`.** `-h` is terse (synopsis + flag list); `--help` is significantly fuller, **including usage examples**. (A house convention, not a deep decision — recorded here so the whole surface is consistent from day one.)

5. **Layout primitives + principles, brand deferred.** Adopt Norn's tool-agnostic _visual primitives_ (count line, record block, table rows, separator, glyph set, indentation) and _house principles_ (counts-before-contents; color is decoration, never information; structured formats never carry style; quiet by default / no celebration; lowercase house style; NO*COLOR/`--ascii` lose nothing). **Mimir's own brand** — color palette, voice, identity glyphs — is a **deferred branding pass**, not inherited from Norn permanently; the \_roles* (a distinct icon+color per `state`) are fixed now, the exact glyphs/palette are not.

## Mimir-specific bindings (the deltas)

- **Identity is the node ID** (`KEY-seq`, e.g. `MMR-16`), not a path. The pipe format is `ids`; the public handle returned everywhere is the rendered ID, never the surrogate integer (ADR 0006).
- **Rank is hidden; array order is the contract.** Per ADR 0007 rank numbers are core-owned and never returned, so `next` returns tasks already in rank order and a consumer trusts _position_. There is deliberately no `rank` field to re-sort on — a script that wants a different order filters/sorts by _signals_ (`priority`, `size`), never rank. This is the one place "hidden rank" becomes externally visible.
- **`state` is a bare field** — the single **State word** (ADR 0008). The raw two axes (`lifecycle`/`hold`/`hold_reason`) and readiness surface in the fuller projection / facets, not in the lean default.
- **`get --format markdown`** (Norn's byte-faithful single document) binds to **fetching one Artifact body verbatim**, not to a task — an artifact is the only Mimir entity that is a markdown blob. Limit-1, as in Norn.
- **Unit / array keys** name the result type: `tasks` for `next`/`list`; node facets (`.annotations`, `.artifacts`, `.deps`, `.history`, `.children`, `.distribution`) TBD in the projection-vocabulary pass.

## Why

- **Don't re-derive a solved problem.** Norn paid the iteration cost (v0.2→v0.27, the find/get unification brainstorm); the contract is dogfooded and sound. Mimir is a different language/runtime (TS/Bun vs. Rust) so it can't share _code_, but it can and should share the _contract_.
- **One contract = one thing to learn and no drift.** An agent (MCP) and a human/script (CLI) learn one projection/format model; the two renderings of the intent envelope can't diverge because they render the same core operations (ADR — glossary **Envelope**).
- **Determinism is the CLI's reason to exist** (glossary **CLI**): stable `json`/`jsonl`/`ids` contracts + stable exit codes are what let a script use Mimir instead of `curl`.

## Considered and rejected

- **Bespoke per-command output shapes** (a hand-rolled `next` row, a different `get` shape) — the exact drift Norn's unification killed; rejected.
- **Compact-DTO vs. full-DTO as two schemas** — puts the boundary at projection; replaced by one projection + selection-appropriate defaults.
- **`paths` as the line format** (Norn's name) — a task has no path; `ids` is the honest Mimir binding.
- **Exposing `rank`** so scripts can re-sort — violates ADR 0007 (core-owned numbers); order carries the intent.

## Consequences

- The MCP tool surface (spec §7) and the CLI share the intent verb set and this output contract; both are thin renderings over the core (ADR — **Envelope**).
- A **buildable Mimir output-contract reference** (the port of Norn's spec with Mimir's concrete facet vocabulary, formats, and exit-code table) belongs in `notes/` at build time — a maintained reference like `mimir-schema-reference.md`, not an Agent Artifact. **Follow-up.**
- **Next design pass:** lock the Mimir projection vocabulary — the bare fields and dot-facets for a task and for a non-leaf node (its `.distribution`), and the lean defaults for `next`/`list` vs. the full `get` record.
- Glossary: add **Output contract** (selection-vs-projection, the four formats, two-layer split).
