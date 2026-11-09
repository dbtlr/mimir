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
- Unpair (`/devices`), Deny (`/pair`), the agent card's Stop, the stop icon
  on a work page's Now row, and the confirm's **Stop run** (MMR-635) use the
  variant. They no longer carry their
  own copies of the classes.
- **Considered and rejected.** A red-filled confirm button, the common
  pattern elsewhere: it is a status hue filling a button, which §1 rules
  out. A neutral outline for destructive actions: the hairline is the only
  cue before the click that the action cannot be undone.
