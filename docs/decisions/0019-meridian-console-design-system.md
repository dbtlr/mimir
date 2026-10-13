---
title: 'ADR 0019: Meridian — the console design system'
status: accepted
date: 2026-07-07
---

# ADR 0019: Meridian — the console design system

Names and fixes the console's design language: **Meridian** — deep blue-black
wells, one teal accent, violet attention, humanist type with mono reserved for
identifiers, dark-first with a fully specified light mode. It replaces the
first-generation "instrument panel" styling, which grew surface by surface
without a recorded system, leaving each new surface to re-derive (or drift
from) the same choices.

This record carries the **rules** — the hard-to-reverse semantic commitments
every surface must obey. The full high-fidelity specification (exact token
values, type scale, per-surface mocks and behavior) is frozen as artifact
`MMR-a42` on the implementation initiative `MMR-215`; pixels may be tuned
there without touching this record. This ADR also extracts the
Overview/attention model into a decision of its own (§9) — ADR 0013 had been
absorbing it as an ever-growing list of refinements.

## The decision

1. **Every hue owns exactly one job.** Four color roles, and roles never
   borrow each other's hues:
   - **Accent (teal)** — selection, active controls, links, focus. Rendered as
     _washes_ (low-alpha fill + hairline inset ring), never solid fills. Never
     marks state.
   - **Action** — the one solid button per surface. Teal-filled in dark;
     slate-filled in light (teal fills read wrong on white).
   - **Attention (violet)** — the "needs you" set only: the top-bar badge,
     verdict blocks, under-review emphasis.
   - **Status (×9)** — dots, 2px card left-borders, bar segments, tinted
     chips. Status hues never fill buttons; control hues never mark state.

2. **Attention is violet, deliberately not red.** The attention set leads with
   `under_review` — work asking for a verdict, not work that is broken. Review
   is opportunity, not error; red stays reserved for the `blocked` status hue.
   This closes the long-open badge-color question (`MMR-103`, which shipped
   red as a conventional notification affordance and was twice deferred).

3. **The status vocabulary is closed at nine and consumed identically
   everywhere** — one mapping for dots, borders, bars, chips, and the mobile
   status sheet (the ADR 0008 vocabulary, projected visually). _Going cold_ is
   a temperature **modifier** (glyph + demoted ink riding whatever status or
   lane a node holds), never a tenth status and never a fifth lane.

4. **Review is verdict-first.** Approving or returning submitted work is the
   highest-leverage operator action in the system, so an `under_review` node
   leads with its verdict block — submitted summary, external ref, inline
   Approve / Return — on every surface that shows it (board card, detail
   views, tree row), not behind a generic menu.

5. **Verbs are labeled chips; the kebab is retired.** Status moves only
   through verbs (ADR 0001), and the affordance now says so: a visible,
   labeled chip row scoped to the legal transitions, everywhere a node can be
   acted on.

6. **Two type voices with a hard boundary.** A humanist sans (Instrument Sans)
   for all prose and UI text; a monospace (JetBrains Mono) strictly for
   machine vocabulary — ids, keys, tags, timestamps-as-data. The uppercase
   microlabel is the single all-caps idiom (column/lane/section captions).
   Fonts are self-hosted (the console is a PWA; no runtime font CDN).

7. **Light mode is a translation, not a recolor.** Six conversion rules cover
   every surface; anything unlisted converts by token table alone: washes gain
   an inset ring; glow becomes a real shadow ramp (shadow from ink, not
   black); demotion drops an ink tier instead of opacity (opacity is reserved
   for the offline full-page demotion); machine ground stays dark (source/code
   readouts keep the dark well inside light surfaces — the inversion marks the
   boundary between UI and record; inline code is refined below, MMR-445);
   amber text on white uses the darkened family, the bright variant is
   decoration-only; unvalidated token values are validated on a rendered
   composite before implementation locks them.

8. **The motion budget is exhaustive.** Three movers: the in-progress pulse
   dot, the detail panel/sheet slide, and note expand/collapse. Nothing else
   moves — no hover lifts, no springs. Adding a fourth mover is a revisit of
   this ADR, not a styling choice.

9. **The Overview/attention model, extracted.** Decided across
   `MMR-100`–`MMR-111` and previously recorded only as ADR 0013 refinements;
   this section is now the decision of record:
   - **Attention** names the top-bar alert only: the cross-project set that
     needs the operator — `under_review` → `blocked` → _going cold_ — ordered
     by how much the operator's action moves it. Healthy `in_progress`/`ready`
     work is never "attention"; a stale item surfaces as _going cold_, not its
     healthy status word.
   - **Lane** names the Overview's per-project standing: four values in
     action-impact order, highest-wins over a project's leaf tasks
     (`awaiting_you` → `live` → `needs_unsticking` → `at_rest`),
     recency-ordered within a lane, `at_rest` folded away. The Lane vocabulary
     is deliberately four values, not the status set — it is the
     operator-facing sibling of the container rollup word.
   - The two are distinct concepts with distinct names; reusing "attention"
     for both was the naming bug the `MMR-111` rename fixed.

## Why

- **A recorded system is what keeps N surfaces one product.** The console now
  spans board, tree, detail, browsers, authoring, and the roadmap surfaces
  (seeds, record health, archive). Without fixed roles, each surface
  re-answers "what does teal mean here" — the drift the one-hue-one-job rule
  exists to prevent, and the reason the light board clashed before the role
  split.
- **The semantic commitments are the expensive part.** Hexes and paddings are
  cheap to tune; what a hue _means_, whether review reads as error, and
  whether motion is scarce are commitments every future surface builds on —
  exactly the "expensive to reverse" bar for an ADR.
- **Verdict-first follows from the model.** `under_review` ranks just under
  `in_progress` in the interpret cascade (ADR 0008) and leads the attention
  set; a design system that buries the approve/return affordance in a generic
  menu contradicts the model's own priority.
- **The attention model deserved its own record.** Three refinement sections
  on ADR 0013 (and counting) is how a decision hides; extraction gives the
  Lane/Attention split one citable home while 0013 keeps the SPA-shape
  decision it actually made.

## Considered and rejected

- **Red attention badge** — conventional for notification counts, wrong for a
  set led by the non-error `under_review`; it taxes the operator with false
  alarm. (Shipped in v0.12, now reversed.)
- **Status hues on controls** (status-colored buttons/fills) — collapses the
  state/control distinction the role system draws; a colored button reads as
  both an action and a state and is ambiguous as either.
- **A `cold` status or a fifth `going_cold` lane** — staleness is orthogonal
  to both axes; modeling it as a value would fork the closed vocabularies
  (ADR 0008's cascade and the four-lane order) for a decoration.
- **Light mode as an independent theme** — a second design to maintain and
  drift; the translation rules keep light derivable from dark plus six
  exceptions.
- **Keeping the kebab for verbs** — hides the system's most important
  affordances behind an unlabeled control; fine for a read-only console,
  wrong once intervention is the job.
- **A per-surface motion vocabulary** — motion that varies by surface reads
  as inconsistency, not richness, at this density; the scarce budget is what
  makes the pulse dot legible as "live."

## Consequences

- Implementation is initiative `MMR-215` (foundation re-skin, then surface
  recreations), deliberately sequenced after the storage cutover
  (`MMR-131`); design artifact `MMR-a42` is the normative spec. This ADR
  governs any conflict between an implementation shortcut and the rules
  above.
- Tokens land in the existing `@theme` vocabulary (`well-*`, `ink-*`, `line`,
  `accent`, `status-*`) plus new `--action` and `--attention` roles. Status
  classes stay literal for Tailwind static extraction, or gain a
  token-indirection layer — decided at the foundation task, not per surface.
- ADR 0013 remains the decision of record for the SPA shape, navigation
  grammar, board-as-primary-lens, and offline posture; its attention-model
  refinements (v0.12/v0.13) are historical narrative superseded by §9. A
  dated pointer is appended there.
- The `MMR-103` badge-color open question is closed by §2.
- New surfaces (seeds, record health, archive) inherit the role system as a
  constraint: e.g. record-damage surfacing is amber ("the system is
  behaving"), never red, and never joins the violet needs-you set's hue.

## Refinement (2026-10-10, MMR-445): inline code is coloured text; code blocks stay machine ground

Rule 4 of §7 keeps source and code readouts on the dark well in both themes,
because the inversion marks the boundary between UI and record. Fenced code
blocks and source readouts keep that treatment unchanged.

Inline code inside prose is not a readout. It renders as monospace text, with
no pill, in a dedicated token: `--color-code` (`#e59ac0` in the dark theme,
`#a8326e` in the light theme). It is the only hue in the palette with no status
meaning, so it reads as distinct from links (accent) and from code blocks
(machine ground). Measured contrast: 8.69:1 against the dark page and 8.24:1
against the dark panel; 5.41:1 against the light page and 6.28:1 against the
light panel.

Code inside a fenced block keeps the machine ink and never takes the inline
colour.

## Refinement (2026-10-12, MMR-438): only blocks you own need you

§9 put every `blocked` task in the attention set. A block waiting on another
team or board is not something the operator can move, so counting it as
needing the operator dilutes the set. With block ownership (ADR 0001, block
ownership refinement), the set's `blocked` member narrows to blocks owned by
`you`.

- A block owned by `others` keeps the `blocked` status word and its red hue
  everywhere; it leaves only the needs-you set.
- _Going cold_ is unchanged and still applies to blocks of either owner, so a
  stale external block returns to the set as going cold.
- The narrowed set applies wherever the console counts what needs the
  operator: the top-bar alert today, and the cross-project review page
  (MMR-440) when it lands.
- Lanes are out of scope here. The review page revisits the Overview, and
  until then any blocked leaf still reads `needs_unsticking`.

## Refinement (2026-10-12, MMR-466): grooming chips stay out of the attention hue

Grooming state (ADR 0033) is a pre-start judgment, not part of the needs-you
set, so its chips never take the attention violet.

- Needs answers borrows the amber that record damage uses: an unresolved
  concern while the system is behaving, not a request for the operator.
- Groomed and not groomed stay neutral. Groomed is brighter and carries a
  check, so the two differ at a glance and in greyscale. A green chip is not
  used, because on a ready card it would read as done.
- Whether needs-answers tasks join the needs-you set is the review page's
  decision (MMR-440). If they do, that page's rows take the attention hue, and
  the chip keeps its amber.

## Refinement (2026-10-12, MMR-467): a work page's needs-you set includes tasks that need answers

The work page (ADR 0013, work-page refinement) has a _Needs you_ section for
its scope. A task whose grooming state is _needs answers_ waits on the
operator's answer, and nothing else moves it, so the section includes it.

- On a work page, _Needs you_ is tasks under review, blocks owned by `you`,
  and `todo` tasks with no hold whose grooming state is _needs answers_, in
  that order. A parked or blocked task's grooming state does not put it in
  the set (ADR 0033 reads grooming for unheld `todo` tasks only).
- A needs-answers row takes the attention hue and shows its latest note,
  which is normally the question its grooming call wrote. Its grooming chip
  keeps its amber (MMR-466 refinement).
- _Going cold_ is not part of a work page's _Needs you_. The page lists stale
  work in its own _Going cold_ section, and a stale row in _Needs you_ carries
  the stale chip.
- This amends the block-ownership refinement's rule that one narrowed set
  applies wherever the console counts what needs the operator. A work page's
  _Needs you_ is its own set, so its count can differ from the top-bar alert.
  The alert keeps §9's set as narrowed by block ownership. The review page
  (MMR-440) still decides its own set, and whether the alert follows it.
