---
title: 'ADR 0024: CLI command taxonomy — two planes, flat work verbs'
status: accepted
date: 2026-07-16
---

# ADR 0024: CLI command taxonomy

The command surface grew verb-by-verb to roughly forty commands with no
holistic pass on naming or grouping, mixing flat verbs (`start`, `done`,
`list`) with ad-hoc noun groups (`service <op>`, `vault snapshot`,
`skill install`). The v0.16 taxonomy audit (MMR-277) inventoried the full
surface and settled the grammar. This ADR records the rules; they govern every
future command addition and rename.

**Decision — the two-plane rule.** Every command belongs to one of two planes,
and the plane dictates its grammar:

- **Work plane** — anything that reads or mutates work state (the board,
  nodes, seeds, artifacts, structure) is a **flat top-level verb**. This is
  the agent hot path, invoked constantly; it never pays a namespace tax
  (`mimir done KEY-42`, never `mimir task done KEY-42`).
- **Machinery plane** — anything about the installation, host, or store
  rather than the work (supervision, snapshots, skill distribution) is a
  **noun group**: `service <op>`, `vault <op>`, `skill <op>`. These are rare,
  operator-driven, and benefit from a discoverable namespace.

The litmus for placing a new command: _is this about the work, or about the
machine that holds the work?_ Work → flat verb. Machine → noun group.

**The loner rule.** A machinery noun group must earn its nesting: it requires
at least two operations on the same noun, present or clearly imminent. A
single-op machinery command stays a flat verb (`setup`, `serve`, `mcp`,
`version`, `self-update`) until siblings appear; moving a loner into a group
at that point is an acceptable pre-1.0 break.

Two current groups are single-op and are retained under the imminence
clause, explicitly: `vault` (only `snapshot` today) is the designated home
for future store operations, and `skill` (only `install` today) has plainly
plausible siblings (`update`, `uninstall`). The audit's zero-regroup outcome
below rests on this clause; without it the loner rule would flatten both.

One recorded exception: **`doctor` stays top-level** even though it is
machinery with a plausible home under `vault`. `<tool> doctor` is a strong
ecosystem convention (`brew doctor`, `npm doctor`, `flutter doctor`), it is
the most guessable name for "something is wrong, check it", and the recovery
command should not sit one level down from the operator who is already in
trouble. Convention strength beats grouping purity.

**Lifecycle grammar: flat verb + typed id.** Status verbs are generic English
words disambiguated entirely by the id argument's grammar (`KEY`, `KEY-seq`,
`KEY-aN`, `KEY-sN`); a verb rejects id types it cannot act on. The seed
lifecycle (`promote`, `reject`, `resolve`, plus the `triage` sweep) is
deliberately parallel to the task lifecycle (`start`, `submit`, `return`,
`done`, `abandon`, `reopen`, and the holds) — `resolve KEY-s10` follows the
same flat-verb-plus-typed-id grammar as `done KEY-42` (argument arity varies
per verb; the grammar does not). Two rules ride on this:

- The seed verbs' names are **seed-exclusive**: a future feature wanting one
  of these words picks a different verb rather than overloading the name.
- The `seed` (capture) / `seeds` (query) singular–plural pair is a
  **grandfathered one-off idiom**, kept because zero-friction capture is the
  point of seeds. It is not a pattern: no `tasks`, no `projects` — `list`
  owns node queries.

**Creation grammar.** `create <project|initiative|phase|task>` is the single
creation verb for tree nodes — four types sharing one shape take one verb
with a type positional, not four top-level verbs. A record type gets its own
creation verb only when its creation ergonomics are the feature: `seed`
(zero-friction capture) and `attach` (the node relation is the command's
essence). No new top-level creation verbs beyond these.

**`overview` is born into the taxonomy** (MMR-278): a flat, id-free,
scope-honoring read verb, sibling to `next`/`list`/`get`/`status`/`tree`,
composing the session-boot orientation surface.

**Rename policy (pre-1.0): hard breaks, no aliases.** A rename removes the
old verb outright — no alias or shim table, which would let two names mean
one thing and reintroduce exactly the drift this taxonomy exists to prevent.
The existing unknown-command suggestion surface may carry a tombstone for a
renamed verb ("renamed to X"; still exits 2). A rename is not complete until
the CLI help registry, the reference docs, and the distributed skill
references are updated in the same change. The post-1.0 policy is
deliberately deferred: no external consumers exist to design for.

## Audit outcome

Applying these rules to the full inventory produced **zero renames and zero
regroups** — the surface as grown already conforms; the audit's yield is the
explicit ruleset. The only conformance gaps are in the help surface, not the
grammar: the top-level help grouping does not reflect the two planes, and
`skill`, `service`, and `self-update` lack `COMMAND_HELP` descriptors (they
fall back to top-level help on `-h`/`--help`). Tracked as MMR-286 (help
regrouping + descriptors) and MMR-287 (skill-reference alignment).

## Considered and rejected

- **Noun-scoping the work-plane families** (`task done`, `seed resolve`).
  Taxes the hot path for symmetry's sake, and breaks the one grammar the task
  and seed lifecycles already share; the typed id disambiguates without a
  namespace.
- **`vault doctor`.** Grouping-pure but buries the recovery command below the
  ecosystem-conventional top-level name; rejected per the `doctor` exception
  above.
- **Overloading `status` (bare = board overview) or bare `mimir` for
  orientation.** The former forks one verb's contract on arity (`status` is
  id-required and JSON by default on every destination); the latter makes a bare or typo'd
  invocation open the store — bare invocation stays help.
- **An alias/deprecation shim table.** Compatibility machinery for an
  audience (external consumers, muscle-memory fleets) that does not exist
  pre-1.0; the tombstone suggestion covers the miss honestly.
- **Folding `seed` and `attach` into `create`.** `create seed` taxes capture,
  `create artifact --on KEY-42` buries the relation that is the command's
  point.

## Consequences

- Placement of any future command is derivable, not debatable: apply the
  plane litmus, then the loner rule. Review should treat a command that
  violates them as a defect.
- The `COMMAND_HELP` registry becomes taxonomy-complete — every dispatched
  verb carries a descriptor, and top-level help groups by plane (MMR-286).
- The distributed skill teaches the same grammar the binary implements
  (MMR-287); rename PRs must keep it that way (same-change rule).
- Per-command help (the MMR-118 thread) bakes in this hierarchy — which is
  now the intent, not a risk.
- `mimir overview` lands under its audited name and placement (MMR-278).
