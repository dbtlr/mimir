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
  that order. Grooming state alone never puts a parked or blocked task in
  the set: a parked task stays quiet, and a block owned by `you` is already
  in the set as a block.
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

## Refinement (2026-10-13, MMR-476): the review page decides what needs you, and the alert counts its decisions

The review page (ADR 0013, review-page refinement) replaces the Overview at
`/`. It lists what needs the operator across projects in two tiers, and the
top-bar alert follows its first tier. §9 and the refinements above are
revised:

- **Decisions** are the work page's needs-you set (MMR-467 refinement) taken
  across every active project: tasks under review, blocks owned by `you`, and
  `todo` tasks with no hold whose grooming state is _needs answers_. Each
  waits on the operator, and nothing else moves it. Their rows take the
  attention hue, and a verdict row leads with its verdict (§4). An active
  project is one that is not archived; archived projects contribute nothing
  (ADR 0015).
- **Triage** is what needs the operator eventually but stops no agent:
  untriaged seeds (a parked seed is not untriaged, MMR-473), `doctor`
  findings, and tasks going cold. The review page counts them per project.
  They never take the attention hue: seeds keep their kind hues, findings the
  amber of record damage, and going cold its cold hue. (Going cold draws in
  ink since the MMR-619 refinement, and seed kinds since MMR-626.)
- **Attention, the top-bar alert, counts decisions only.** It becomes a link
  to `/` carrying the count, and it is absent when there are no decisions.
  Its per-project `doctor` lines and its amber findings pill retire; findings
  are counted in the review page's triage tier instead. Going cold leaves the
  alert. `stale` includes `ready` tasks nobody has
  started, so a board with a deep backlog keeps the alert lit permanently: on
  2026-10-13, 90 tasks across projects were stale, and the alert carried no
  signal. This reverses the v0.13 choice (MMR-111) to keep stale tasks in the
  set. The cross-project view of stale work moves to the review page's
  _Going cold_ count, and each work page keeps its _Going cold_ section.
- **One set, one count.** The alert, the review page's title count, and the
  project list's decision counts are the same set, so they never disagree.
  A work page's _Needs you_ is that set within its scope.
- **Lanes retire with the Overview.** §9's Lane is retired as a concept, not
  only as the Overview's grouping: the `attention` facet that carries it
  leaves the facet set (the projects read, `get --col attention`, and MCP
  `get`), and `overview`'s hygiene rows drop their per-row lane word. A
  blocked or stale row already carries its status word.
- **Decisions are ordered for the agents they free.** On the page, decisions
  group by project. A project's urgency is its leading decision kind: a
  verdict, then a block on you, then a question. Projects order by urgency,
  and ties go to the project whose leading-kind decision was updated most
  recently. Inside a project, the work page's order applies. The review
  page's project list uses the same order, then lists projects with no
  decisions by their triage count (untriaged seeds, plus tasks going cold,
  plus findings), most first, then by key. The
  focus queue drops the grouping and walks every verdict first, then every
  block on you, then every question, newest first within each kind, because
  a verdict usually frees an agent that is waiting now.

Considered and rejected:

- **Keeping findings in the alert, or adding seeds.** 120 findings and 33
  untriaged seeds across projects on 2026-10-13 would keep the alert lit for
  the same reason going cold did.
- **Going cold rows on the review page.** 90 rows bury the decisions; a count
  per project that links to the work page keeps the signal without the list.

## Refinement (2026-10-13, MMR-492): Needs you opens a popover of decisions

§9 and the MMR-476 refinement made the top-bar alert a link to `/`. With the
console now framed by a project sidebar (ADR 0013, project-sidebar
refinement), a jump to the review page for every glance at the set moves the
operator out of the project they are in. §9's "the top-bar alert is a link to
`/`" is revised:

- **_Needs you_ opens a popover, a bottom sheet on a phone.** It lists the
  decisions grouped by project, in the review page's order (MMR-476
  refinement), each with its in-place verbs (_Approve_, _Send back…_,
  _Answer…_). The decision for the record on the current page is marked. The
  popover links to the review page and to the focus queue (`/?mode=focus`).
- **The hue and the count are unchanged.** Violet stays the attention hue, the
  count badge carries the decision count, and the alert is absent when there
  are no decisions. The popover lists the same set the badge counts.

## Refinement (2026-10-13, MMR-504): the project listing orders by pin, then activity

The MMR-476 refinement says the review page's project list uses the decisions
order, then lists projects with no decisions by triage count. That is
superseded for the project listing (the health strip, ADR 0013 MMR-503
refinement):

- **The project listing orders pinned projects first, then the most recent
  activity, then the key.** The review report's `projects` array carries this
  order, the same one the project switcher uses.
- **Decision groups keep the urgency order.** The MMR-476 rules still govern
  `decisions` and the focus queue, and `triage` keeps its count order.

## Refinement (2026-11-02, MMR-615): a review is not a decision

`under_review` is work in flight (ADR 0001, MMR-615 refinement), so a task
under review leaves the decisions set. This ADR's §9 member list and its own
MMR-467, MMR-476, and MMR-492 refinements are revised, and so is the premise
that the attention set leads with `under_review`, in §2, the _Why_ section,
and the rejected red badge:

- **Decisions are blocks owned by `you`, then `todo` tasks with no hold whose
  grooming state is _needs answers_.** That one set is a work page's _Needs
  you_ within its scope, the review page's decisions, the top-bar alert's
  count and popover, and the project health strip's decision count.
- **The order loses its verdict tier.** A project's urgency is its leading
  decision kind, a block on you and then a question. The focus queue walks
  every block on you, then every question, newest first within each.
- **The attention role marks the decisions set only.** The task page keeps
  its verdict block for a task under review, with _Approve_ and _Send
  back…_, but the block no longer takes the attention hue or reads _Needs
  your verdict_. §1's "verdict blocks, under-review emphasis" is superseded.
  The attention hue stays violet, not red: the set is still work waiting on
  the operator, not work that is broken, and red stays the `blocked` status
  hue (§2). The `under_review` status hue is a status hue (§3) and is
  unchanged, though it is the same violet family (the identical hex in the
  dark theme), so a review's status dot in _Now_ reads violet while its row
  takes no attention rule.
- **Verdict verbs leave the lists.** Rows on the work page, the review page,
  the popover, and the focus queue no longer carry _Approve_ or _Send back…_;
  §4's verdict-first rule now holds on the task page only.

## Refinement (2026-11-02, MMR-617): `under_review` takes chartreuse

The MMR-615 refinement left the `under_review` status hue on the attention
violet. That broke §1's rule that roles never borrow each other's hues: a
review's status dot read as "needs you" on rows that no longer need the
operator. The `under_review` status hue is now chartreuse.

| Token                                    | Dark      | Light     |
| ---------------------------------------- | --------- | --------- |
| `--color-status-under-review`            | `#a7bd58` | `#6b8316` |
| `--color-status-under-review-foreground` | `#c1d582` | `#4c5e08` |

- **Why chartreuse.** It takes the widest open gap in the palette's hue
  circle, between in-progress amber and done green, so amber, then
  chartreuse, then green reads as the path to done. Its OKLab distance (ΔE
  ×100) is 9.5 to `in_progress` and 9.9 to `done` in the dark theme, 8.5 to
  `done` and 11.9 to `in_progress` in the light theme. It sits at least
  20.9 from every attention token in the dark theme and at least 23.0 in the
  light theme, base and foreground alike. The closest status pairs before this
  change were `queued` and `ready` at 5.2 in the dark theme, and `awaiting`
  and `abandoned` at 4.0 in the light theme.
- **Contrast.** The foreground measures 11.73:1 against the dark page and
  11.12:1 against the dark panel, and 6.22:1 against the light page and
  7.21:1 against the light panel. The base, used for dots and borders,
  measures 9.00:1 and 8.54:1 dark, and 3.71:1 and 4.30:1 light. On a
  status chip's 12% wash, the foreground measures 9.56:1 and 8.95:1 dark,
  and 5.44:1 and 6.24:1 light, all above AA's 4.5:1.
- **Considered and rejected.** Periwinkle (`#a09cf0` dark, `#605ac4`
  light) kept the cool family but sat ΔE 4.1 from the attention violet.
  Coral (`#ef945f` dark, `#c16229` light) cleared violet but sat about 6
  from `in_progress` and `blocked`, so a review could read as a warning.
- **What violet means now.** The attention role marks what waits on the
  operator: the decisions set (blocks owned by `you`, then questions) and
  its counts, the seed queue's ready-to-resolve lane, including a ready
  seed's spawned-work reference, and device pairing requests with their
  _Approve_ action. This widens §1's "the 'needs you' set only" and the
  MMR-615 refinement's "the attention role marks the decisions set only":
  a ready seed and a pairing request wait on the operator without being
  decisions. It narrows nothing else. A seed's spawned-work reference
  while its work is still in flight is plain ink, and seeds outside the
  ready lane keep MMR-476's rule that they never take the attention hue.
- **No status hue uses violet.**
  `packages/host/src/test/role-hues.test.ts` fails if a status token is
  declared outside the two theme blocks or more than once in one, is not a
  plain hex, shares a hex with an accent, action, attention, or code token,
  or sits within ΔE 6 of an attention token, in either theme.
  This supersedes the MMR-615 refinement's note that the `under_review`
  status hue is unchanged.
- **The vocabulary is ten.** ADR 0008's MMR-564 refinement added `queued`,
  so §3's status vocabulary is closed at ten words, not nine, and each takes
  one status hue.
- The CLI's ANSI status colors are out of scope. The terminal has no
  attention role, so `under_review` stays magenta there.

## Refinement (2026-11-02, MMR-619): the cold count draws in ink, and the cold token retires

The review page's per-project cold count drew in `--color-cold`, a token
only it and the `/kit` swatch used. That token sat on the `awaiting` status
base: the same hex, `#8a9aa8`, in the light theme, and OKLab ΔE ×100 2.2 away
in the dark theme. So the one thing the console coloured "cold" wore a status
hue, against §1. The count is text, and the light value measured 2.49:1
against the page and 2.89:1 against a panel, below AA's 4.5:1.

- **The cold count draws in demoted ink.** It uses `ink-dim` (`#8fa0ae`
  dark, `#5a6b77` light): 6.99:1 and 6.62:1 against the dark page and
  panel, and 4.76:1 and 5.52:1 against the light page and panel. The column
  header names the count. `--color-cold` is retired in both themes, and
  the `/kit` swatch with it. This supersedes the MMR-476 refinement's "going
  cold its cold hue".
- **§1 governs hues, not ink.** Ink is the console's neutral
  text, shared by every surface, so §1's one-hue-one-job rule and the
  MMR-617 distance floor, which binds a status to the attention role, do
  not apply to it. `ink-dim` shares its hex with the `new` status, and in
  the light theme it sits ΔE 1.0 from `awaiting`'s text tone (`#5f6d7a`)
  and 3.0 from `parked`'s, as all secondary text already does. Each count in the
  strip is told apart by its column header. The live count takes the
  `in_progress` hue because live work is in flight; the cold count has no
  status to show, so it takes neutral ink.
- **The count carries no glyph.** §3's glyph marks a node's modifier. The
  count is an aggregate under a header that already says _cold_, and a ◌
  before it repeated that.
- **Scope.** This refinement covers the cold count. The stale chip that
  marks a going-cold row (`⧗ stale`) draws in the `in_progress` amber;
  whether it keeps that hue is MMR-620 (settled: it moves to ink; see the
  MMR-620 refinement). No status token changes.
- **Considered and rejected.** A frost teal (`#3d908b` dark, `#207773`
  light) cleared every status by ΔE 6 and passed AA. In the light theme it
  sat ΔE 6.3 from the accent teal that colours the project key in the same
  row, and 6.1 from `done`'s text green.
- `packages/host/src/test/role-hues.test.ts` fails if either theme declares
  a `--color-cold` token, and the review page's test fails unless the cold
  count draws in `text-ink-dim`.

## Refinement (2026-11-03, MMR-620): the stale chip draws in ink

The `⧗ stale` chip that marks a going-cold row drew in the `in_progress`
amber wash. `stale` also marks `ready`, `queued`, `under_review`, and
blocked tasks, and on those rows the amber read as work in flight: the
status misreading MMR-617 removed for `under_review` and MMR-619 removed for
the cold count. §3 already draws going cold as a glyph plus demoted ink, so
the chip had drifted from the decision rather than extended it.

- **The stale chip is a neutral chip.** It takes the badge's default
  ground (the `well-800` fill under a `line` hairline ring) with `ink-dim`
  text, the size chip's ground and text colour in the sans face: 6.37:1
  against its fill in the dark theme and 5.13:1 in the light. The ⧗ glyph and the word carry the
  modifier; no hue does. This settles the MMR-619 refinement's open scope
  note.
- **Considered and rejected.** Keeping the amber as a caution, in the
  family record damage and needs answers use: it still read as
  `in_progress` on a `ready` or blocked row, against §3. Bare glyph and text
  with no chip: closest to §3's words, but in a task page's row of signal
  chips it read as stray text. An outline chip with no fill: lighter than its
  neighbours, but not chosen.
- The work page's test fails unless the chip, on a frontier row and a
  _Going cold_ row, draws in `text-ink-dim` with no `status-` class.

## Refinement (2026-11-04, MMR-626): priority and seed kind draw in ink

Two chip families borrowed status hues with no recorded basis. The priority
chip drew p0 in the `blocked` red and p1 in the `in_progress` amber, in the
task page's signals and the authoring sheet's selected pill. The seed-kind
chip drew `bug` in the `blocked` red, `idea` in the `in_progress` amber, and
`feature` in the `ready` blue, on every seed surface and in the seed
capture's selected pill. The MMR-476 refinement said only that seeds keep
their kind hues. So a p0 task read as blocked and an idea as work in flight:
the status misreading MMR-617, MMR-619, and MMR-620 removed elsewhere.

- **Priority steps down the ink ramp.** Priority is ordinal, so brightness,
  which is ordinal too, carries it. Every priority chip keeps the badge's
  default ground (the `well-800` fill under a `line` hairline ring). p0
  draws in `ink-bright`, semibold, under the `line-bright` ring; p1 in
  `ink`; p2 and p3 in `ink-dim`. p3 stops at `ink-dim` because `ink-faint`
  measures 3.11:1 (dark) and 2.84:1 (light) against the chip ground, below
  AA's 4.5:1; `ink-dim` measures 6.37:1 and 5.13:1. Their labels tell p2
  and p3 apart.
- **Seed kind is a category, so every kind draws alike.** The kind chip is
  a neutral chip in `ink-dim` on the same ground; the label carries the
  kind. This supersedes the MMR-476 refinement's "seeds keep their kind
  hues".
- **A selected pill is a selection, not a status.** The authoring sheet's
  priority pills and the seed capture's kind pills select with the size
  pill's treatment (a `line` fill with `ink-bright` text), so the sheet's
  two signal pickers, which sit side by side, select alike. They keep that
  neutral fill rather than the accent wash §1 gives selection and the list
  filter chips use; whether form pickers move to the accent is left open.
- **Considered and rejected.** Flat neutral chips for every priority: p0
  read the same as p3 at a glance. A ▲ mark on p0 alone: a new glyph to
  learn, and p1 to p3 read the same.
- `packages/host/src/test/signal-chips.test.tsx` fails if a priority or kind
  chip carries a `status-` class, if the priority ink steps change, or if
  two kinds draw differently. The authoring sheet's and seed capture's tests
  fail if a selected priority or kind pill carries a `status-` class or
  loses the `bg-line` fill or `ink-bright` text.

## Refinement (2026-11-09, MMR-635): a destructive action wears a red hairline

"Status hues never fill buttons" (§1) and the rejected "status hues on
controls" leave one case open: the control that ends something, such as
unpairing a device, denying a pairing request, or stopping an agent run. These
controls use one `ActionButton` variant, `destructiveOutline`: an outline whose
hairline and label take the `blocked` red, on a neutral hover. Nothing fills,
so a destructive control never reads as the page's one solid action or as a
state. The red marks the consequence of the click, and the label names it.

- The hairline is the only status hue a control may wear, and only for an
  action that ends or removes something. A confirm keeps the destructive
  button an outline too, beside a neutral safe choice that takes focus first.
- Unpair and its confirm (`/devices`), Deny (`/pair`), the agent card's Stop, the stop icon
  on a work page's Now row, and the confirm's **Stop run** (MMR-635) use the
  variant. They no longer carry their
  own copies of the classes.
- **Considered and rejected.** A red-filled confirm button, the common
  pattern elsewhere: it is a status hue filling a button, which §1 rules
  out. A neutral outline for destructive actions: the hairline is the only
  cue before the click that the action cannot be undone.

## Refinement (2026-11-14, MMR-675): `staged` takes green

ADR 0001's MMR-675 refinement adds `staged`, accepted work not yet on `main`.
It takes the green between `under_review`'s chartreuse and `done`'s jade, so
amber, chartreuse, green, then jade reads as the path to done.

| Token                              | Dark      | Light     |
| ---------------------------------- | --------- | --------- |
| `--color-status-staged`            | `#78c066` | `#428c2a` |
| `--color-status-staged-foreground` | `#a4d48d` | `#356a18` |

- **Distance.** Its OKLab distance (ΔE ×100) is 5.3 to `under_review` and 5.8
  to `done` in the dark theme, 4.7 and 6.6 in the light theme. Those are its
  nearest status hues. The closest status pairs stay `queued` and `ready` at
  5.2 dark and `awaiting` and `abandoned` at 4.0 light.
- **Contrast.** On a status chip's 12% wash, the foreground measures 9.12:1
  against the dark page and 8.55:1 against the dark panel, and 4.91:1 and
  5.62:1 light, all above AA's 4.5:1. The base, used for dots and borders,
  measures 8.53:1 and 8.09:1 dark, and 3.61:1 and 4.19:1 light.
- **Considered and rejected.** Teal (`#45b5b0` dark, `#1b8580` light) drifted
  toward `ready`'s blue. Mint (`#8ad0a8` dark, `#3f9468` light) read as a pale
  `done`.
- **The vocabulary is eleven.** §3's status vocabulary is closed at eleven
  words, and each takes one status hue.
- The CLI's ANSI status colors are out of scope; `staged` is magenta there,
  beside `under_review`, with its own glyph.

## Refinement (2026-11-16, MMR-680): the delivery page

A delivery ([ADR 0042](0042-the-delivery-record.md)) gets its own page at
`/p/KEY/d<seq>`, in the layout of variant A of the build-run design's mocks
(artifact MMR-a398). It puts what needs the operator first. This refinement
records the page's read-only shape. MMR-694 adds the needs-you set's new rows,
and MMR-695 adds the answer and verb controls.

- **The address.** `/p/KEY/d<seq>` reads `KEY-d<seq>`. A sequence with leading
  zeros redirects to the canonical address, as a seed's `s<seq>` does. An
  unknown delivery, or one in an archived project, shows the not-found state.
- **The order, phone first.** One scroll, in this order:
  1. A header: the breadcrumb (project, phase, delivery), the title, the
     lifecycle and hold words, and a time bar that fills elapsed time against
     the time cap. With no cap, elapsed time shows as text with no bar. A
     delivery that has not started reads "Not started".
  2. The stop, when the delivery is `stopped`: its reason in a verdict block.
  3. Needs you: the delivery's provisional decisions, each as a decision row
     with its question, class, options, answer taken, and linked tasks, in
     the work page's needs-you group.
  4. Now: the members that are `in_progress` or `under_review`.
  5. Progress: the members as a distribution bar and a count by status.
  6. Follow-ups: each linked follow-up's status and title, and each linked
     task's checklist items.
  7. The known limitations and the declined findings.
  8. The recent run journal: the live pad's latest Journal entries, or a link
     to each frozen journal.
  9. The delivery's facts: branch, pull request, T3 thread, and start, so
     the pull request is in reach on a phone too.
- **Desktop.** At the large breakpoint and up, sections 1 to 5 sit in the
  main column. A rail holds section 9 first, then sections 6, 7, and 8. A
  fact with no value reads "None".
- **Hues.**
  - Attention takes only the stop and the open decisions, because both ask
    the operator to act (§1). A `paused` delivery is the operator's own
    pause, so its notice draws in ink.
  - A delivery's lifecycle and hold words are not task status words. They
    draw in ink, as text chips, so §3's vocabulary stays closed.
  - Members use the status hues as every task row does, `staged` green
    included.
- **The phase page.** A phase's page lists its live deliveries (not `landed`
  or `abandoned`) as cards. Each card shows the delivery's id, title,
  lifecycle and hold words, time, and a distribution bar over its members, and
  links to the delivery's page.
- **Long text wraps.** Titles, reasons, options, and findings wrap anywhere,
  as a seed's and an artifact's title do, so a long unbroken token never
  widens the page past a phone's width.
- **Reuse.** The page is built from the work page's sections, rows,
  distribution bar, and needs-you groups. It adds one kind of row, the
  decision row, for a decision record
  ([ADR 0043](0043-the-decision-record.md)). MMR-694 shows the same row in
  the needs-you set beside the task rows the review page groups, and renames
  the review report's `decisions` field to `needsYou`, so "decision" names
  only a decision record and a decision reads the same on every surface.

## Refinement (2026-11-16, MMR-694): the needs-you set gains decisions and stopped deliveries

The needs-you set (the MMR-476 refinement's first tier) held tasks only. Two
more records now wait on the operator alone: a provisional decision
([ADR 0043](0043-the-decision-record.md)) and a stopped delivery
([ADR 0042](0042-the-delivery-record.md)). Both join the set, so the alert,
the review page, the focus queue, and a work page's _Needs you_ show them and
count them. The MMR-476 refinement's "One set, one count" still holds.

### Membership

- **A stopped delivery:** any delivery whose hold is `stopped`, in an active
  project. A `paused` delivery is the operator's own pause, so it stays out.
  A terminal delivery holds nothing, so it is never in the set.
- **A provisional decision:** any decision whose lifecycle is `provisional`,
  in an active project, whether or not it links a delivery or any task. A
  confirmed or overturned decision is settled, so it stays out.
- **A task** keeps the MMR-615 refinement's rule: blocked with owner `you`, or
  `todo` with no hold and grooming _needs answers_.
- On a work page, the set is narrowed to the page's scope. A stopped delivery
  is in scope when its phase is the page's node or under it. A decision is in
  scope when it links a task in scope, or links a delivery whose phase is in
  scope. A project's page holds every record of the project.

### Order

Five kinds, in this order:

1. A stopped delivery.
2. A decision with work built on it: it links at least one task that is not
   `abandoned`, which is ADR 0043's test for work at risk.
3. A task blocked on you.
4. A task that needs answers.
5. A decision with no work built on it.

A stopped delivery halts an agent now, and a decision with work built on it
puts that work at risk, so both lead. Core decides each decision's kind and
carries it on the row, so no reader re-derives it. Within a kind, the newest
leads by the kind's own clock: a delivery by its `updated_at` (the delivery
last touched, which a limitation or follow-up written while it is stopped
also moves), a decision by its `created_at`, and a task by the existing
recency order. Equal instants go to the lowest sequence, then to the project
key. The order holds:

- inside each project group on the review page and in the alert's popover;
- across projects in the focus queue, which drops the grouping;
- on a work page's _Needs you_.

The delivery page's _Needs you_ (the MMR-680 refinement) holds only that
delivery's provisional decisions, so it orders them by the same two decision
kinds and clocks.

A project's urgency is its leading kind, and the MMR-476 refinement's
"leading decision kind" now ranks these five. Ties go to the project whose
leading record is newest by its kind's clock, then to the project key.

### Rows

- **A stopped delivery** reads as a needs-you row: the delivery's id, title,
  and lifecycle word, the label _Stopped_, and its stop reason. It links to
  the delivery's page.
- **A decision** reads as the decision row of the MMR-680 refinement: the
  question, its class, the options with the taken one marked, and its linked
  tasks. A decision that names a delivery also links to that delivery's page,
  except on that page itself. It is read-only until MMR-695 adds its answer
  controls.
- **A task** reads as before.
- All three take the attention rule, as every row in the set does. The row
  for the record on the current page is marked _This page_: a task on its own
  page, a delivery on its own page.

### Shape and names

- **One ordered list.** A review group, and the work report's `needsYou`, is
  one list of rows in the order above, each row tagged with its `kind`:
  `delivery` (the delivery and its stop reason), `decision` (the decision and
  whether work is built on it), or `task` (the existing task row). The focus
  queue is the same order as a list of `{ kind, id }`. A count is the list's
  length, so the alert, the review page's title, and the project list never
  disagree.
- **The rename.** The review report called its groups of tasks that need the
  operator `decisions`, which ADR 0043 now names a record.
  - `ReviewReport.decisions` becomes `needsYou`.
  - `ReviewDecisionGroup` becomes `ReviewNeedsYouGroup`, holding `rows`.
  - `ReviewProject.decisions` (a count) becomes `needsYou`.
  - The console's `DecisionGroups` becomes `NeedsYouGroups`, and
    `DecisionCount` becomes `NeedsYouCount`.

  "Decision" then names only a decision record. That settles ADR 0043's
  open question of how the two read side by side.
- **Copy.** The console's text follows the rename. The alert's label reads
  "N need you", the project list's count reads "N need you", and the empty
  popover reads "Nothing needs you". A count of one reads "1 needs you". The MMR-476, MMR-492, and MMR-615
  refinements' word "decisions" for the set now reads "the needs-you set":
  the popover lists the set, and the set's tasks are the ones MMR-615 names.
- **The version window.** The rename, `WorkReport.needsYou` changing from a
  list of tasks to a list of tagged rows, and `ReviewReport.queue` changing
  from a list of ids to a list of `{ kind, id }`, are not additive changes
  ([ADR 0038](0038-device-pairing-and-the-version-window.md)). Only the
  host's own console reads the console views; no CLI or MCP command calls
  them. They change in the same unreleased minor as the delivery record, so
  the contract snapshot regenerates and `MIN_CLIENT` stays at that minor's
  floor.

### The focus queue

The queue walks the set's records one at a time in the order above. Each
kind's card shows its row:

- **A stopped delivery** is labelled _Stopped_, with a link to its page.
- **A decision** is labelled with its class, with a link to its delivery's
  page when it names one.

Its _Up next_ line reads the delivery's title or the decision's question.
Until MMR-695 adds their controls, a delivery's or a decision's card offers
_Skip_ only. A task's card is unchanged.

## Refinement (2026-11-16, MMR-695): answering a decision and driving a delivery

The MMR-680 and MMR-694 refinements show decisions and stopped deliveries
read-only. This refinement adds their controls. Every write goes through the
console's waking functions, so a write that wakes the delivery's thread shows
its wake state as the state table of [ADR 0040](0040-outbound-integrations-and-host-secrets.md)'s
wake gives it. `confirm` never wakes.

### Answering a decision

A provisional decision's row carries a chip row wherever the row shows: on
the delivery page, in a review group, in the alert's popover, on a work
page's _Needs you_, and on its focus-queue card. The chips wrap onto more
lines when a decision has many options.

- **Confirm N** confirms the answer taken, where N is the taken option's
  number. One tap commits it, with no note.
- **Take M**, one chip for each other option, overturns to option M. One tap
  commits it, with no note. A decision always has at least two options
  ([ADR 0043](0043-the-decision-record.md)), so a row always offers at least
  one Take chip.
- **Note…** opens the answer dialog, titled "Answer KEY-qN", with its
  question shown. The note is required. The dialog has two outline commits
  beside _Cancel_: _Confirm with note_ confirms the answer taken with the note
  as its outcome note, and _Answer with note_ overturns with the note alone,
  which records an answer outside the list.
- ADR 0043 also allows an overturn to an option with a note. The console
  leaves that out: _Take M_ records the option alone.
- Each chip's accessible name says what it commits, with the decision id and
  the option text, for example "Take option 2 for MMR-q7: Yes, under their
  own heading". The visible label stays short.
- The chips are attention outlines, as a task row's _Answer…_ is, because the
  row is in the needs-you set. Each takes the 44px phone touch target. A
  write in flight disables all of the row's chips. Offline disables them, as
  it does every write (ADR 0013 §5).
- Confirm and overturn are terminal and have no undo. One tap is the
  operator's ruling: the chips name exactly what they commit.
- **Focus never lands on a committing chip by itself.** A confirmed or
  overturned decision leaves the needs-you set, and focus moves on as it
  does when a task row leaves (MMR-474), with one change. When the next row
  is a decision, focus lands on the row itself, which takes focus but does
  nothing on Enter. It never lands on _Confirm N_, a _Take M_ chip, or a
  link. A key held down or pressed twice therefore writes nothing and goes
  nowhere. The mechanism: a decision's chip group is not a handoff target, so
  it sits outside the row's `data-row-actions` group, and the handoff's
  doc says so. A test proves that a decision row arriving next takes focus
  on the row and on no chip.
- On a decision's focus-queue card, the first focus lands on the card itself,
  for the same reason. The decision's chips come before _Skip_. A stopped
  delivery's card keeps _Skip_ and its link to the delivery's page, and its
  first focus stays on _Skip_: a held key there only skips, which writes
  nothing. This replaces the MMR-694 refinement's "Skip only" for a
  decision's card.

### Driving a delivery

The delivery page offers four verbs, and only these four. `return` and
`update` stay off the page. Each verb shows only when ADR 0042 allows it for
the delivery's lifecycle and hold. They sit in a chip row under the header:

- **Clear stop** (`unblock`) shows only on a `stopped` delivery. The stop's
  verdict block (§4) carries the same control, from the same write, so one
  tap in either place commits it.
- **Pause…** (`park`) shows on a non-terminal delivery with no hold. It opens
  the reason dialog, titled "Pause KEY-dN", whose commit reads "Pause
  delivery". The reason is required.
- **Resume** (`unpark`) shows only on a `paused` delivery. One tap commits it.
  The paused notice carries no control of its own.
- **Abandon…** (`abandon`) shows on every non-terminal delivery. It opens the
  reason dialog, titled "Abandon KEY-dN", whose commit is a destructive
  outline (the MMR-635 refinement) that reads "Abandon delivery", beside
  _Cancel_. The reason is required. The chip wears the destructive red
  hairline too, because the verb releases every live member.

The rules for these chips:

- A terminal delivery shows no verbs.
- A verb chip is an outline. Only _Clear stop_ takes the attention outline,
  because only the stop needs the operator.
- A delivery write in flight disables every verb on the page, and offline
  disables them all.
- After a verb commits, focus moves to the page's title, the `h1`, which
  takes focus for this, when focus was lost with the control that unmounted.
  Focus the operator moved elsewhere stays where it is. It never moves to
  another verb, and never to _Abandon…_.
- The page's _Needs you_ group hands focus on as a work page's does.
- A stopped delivery's row elsewhere links to this page and carries no verbs.

### Refusals

A refused write shows its error as a toast, and nothing it touched moves:

- **A dialog stays open.** The answer, Pause, and Abandon dialogs each stay
  open with their text in them, so a required note or reason is never lost.
  Other console reason dialogs keep their current behavior; changing them
  is separate work.
- **A one-tap chip keeps focus.** A refused one-tap chip returns focus to
  itself once the write ends, because its row stays.
