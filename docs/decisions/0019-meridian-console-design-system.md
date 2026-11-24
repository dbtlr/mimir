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
     chips. (For status, the MMR-718 refinement keeps the hue on dots,
     borders, and bars; a status word draws in `ink-bright`.) Status hues never
     fill buttons; control hues never mark state.

2. **Attention is violet, deliberately not red.** The attention set leads with
   `under_review` — work asking for a verdict, not work that is broken. Review
   is opportunity, not error; red stays reserved for the `blocked` status hue.
   This closes the long-open badge-color question (`MMR-103`, which shipped
   red as a conventional notification affordance and was twice deferred).

3. **The status vocabulary is closed at nine and consumed identically
   everywhere** — one mapping for dots, borders, bars, chips, and the mobile
   status sheet (the ADR 0008 vocabulary, projected visually). (The MMR-718
   refinement keeps the hue on dots, borders, and bars, and retires the status
   chip.) _Going cold_ is a temperature **modifier** (glyph + demoted ink
   riding whatever status or lane a node holds), never a tenth status and
   never a fifth lane.

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
   (The MMR-719 refinement gives a feed section a sentence-case head, so the
   microlabel no longer captions one.) Fonts are self-hosted (the console is a PWA; no runtime font CDN).

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

8. **The motion budget is exhaustive.** Four movers: the in-progress pulse
   dot, the detail panel/sheet slide, and note expand/collapse. (2026-11-22,
   MMR-720: the preview panel's slide includes the sidebar's exit and return
   and the feed column's re-centre that travel with it.) (2026-11-23,
   MMR-721: the fourth, the phone Needs you deck's turn from one card to the
   next.) Nothing else
   moves — no hover lifts, no springs. Adding a fifth mover is a revisit of
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
  everywhere; it leaves only the needs-you set. (Since the MMR-718
  refinement the red sits on the status dot; the word draws in `ink-bright`.)
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
  A work page's _Needs you_ is that set within its scope. (2026-11-23,
  MMR-722: Home's page title names the day and carries no count; the alert
  and the Needs you deck head's items count read this set.)
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
  and 5.44:1 and 6.24:1 light, all above AA's 4.5:1. (Historical: the
  MMR-718 refinement retired the status chip and its wash.)
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
  count draws in `text-ink-dim`. (2026-11-23, MMR-722: the cold count left
  with Home's project health strip, and its test with it; the
  `role-hues.test.ts` check stands.)

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
  The MMR-743 refinement settles it for a form's Segmented Control, the seed
  form's Kind among them, which selects with the accent; the authoring
  sheet's pills keep this neutral fill until MMR-731 moves them.
- **Considered and rejected.** Flat neutral chips for every priority: p0
  read the same as p3 at a glance. A ▲ mark on p0 alone: a new glyph to
  learn, and p1 to p3 read the same.
- `packages/host/src/test/signal-chips.test.tsx` fails if a priority or kind
  chip carries a `status-` class, if the priority ink steps change, or if
  two kinds draw differently. The authoring sheet's tests fail if a selected
  priority pill carries a `status-` class or loses the `bg-line` fill or
  `ink-bright` text; the seed form's test, under the MMR-743 refinement,
  fails if a selected kind carries a `status-` class or loses the accent
  wash.

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
- A confirm opens as a modal dialog, never as a box that expands in place on
  the page.
- Unpair and its confirm (`/devices`), Deny (`/pair`), the agent card's Stop, the stop icon
  on a work page's Now row, and the confirm's **Stop run** (MMR-635) use the
  variant. They no longer carry their
  own copies of the classes. Settings › Notifications' **Remove this browser**
  (MMR-711) wears the same hairline and label in a phone's action sheet and
  in a desktop menu, from the classes the variant exports, which the Action
  menu pattern puts on every destructive action (MMR-736).
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
  5.62:1 light, all above AA's 4.5:1. (Historical: the MMR-718 refinement
  retired the status chip and its wash.) The base, used for dots and borders,
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
    included. (Since the MMR-718 refinement, a status word draws in ink too,
    so the hue on its dot is what tells a status from a lifecycle word.)
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
  disagree. (2026-11-23, MMR-722: Home's page title names the day and carries
  no count.)
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
  (2026-11-23, MMR-721: its Needs you deck card carries _Clear stop_; its
  needs-you rows still carry none.)

### Refusals

A refused write shows its error as a toast, and nothing it touched moves:

- **A dialog stays open.** The answer, Pause, and Abandon dialogs each stay
  open with their text in them, so a required note or reason is never lost.
  Other console reason dialogs keep their current behavior; changing them
  is separate work.
- **A one-tap chip keeps focus.** A refused one-tap chip returns focus to
  itself once the write ends, because its row stays.

## Refinement (2026-11-18, MMR-703): the decisions walkthrough

The MMR-695 chips answer one decision at a time, wherever its row shows. The
**decisions walkthrough** answers a set of decisions in order, one decision
per screen, and sends the answers together. Each decision reads as the
agent's briefing. The chips stay as MMR-695 defines them.

### Where it opens

- `?mode=decisions` on a delivery page (`/p/KEY/dN?mode=decisions`) opens
  the walkthrough of that delivery's provisional decisions. On a project's
  page (`/p/KEY?mode=decisions`) it opens the walkthrough of the project's
  provisional decisions that name no delivery. `mode` takes no other value,
  and the page drops one it does not know.
- This refinement defines the walkthrough and its address. The controls that
  open it from other surfaces are defined separately.

### The set

- A delivery's set is the provisional decisions of the delivery page's read.
  A project's set is the decisions of the project page's _Needs you_ that
  name no delivery. Both reads hold provisional decisions only.
- The set is fixed when the walkthrough opens, ordered by sequence number,
  oldest first. This departs from the needs-you order, newest first, on
  purpose: a walkthrough reads in the order the agent decided. A decision
  that joins the read later waits for the next opening, as in the focus
  queue. An opening holds at most 100 decisions, the oldest, which is the
  most one _Send_ takes; the rest wait for the next opening.
- A decision that leaves the live read while the walkthrough is open,
  because it was answered or moved elsewhere, shows "This decision no longer
  waits on you" in place of its answers, and _Send_ leaves it out. Its step
  has no effect line or note box, and its step's button moves on without an
  answer: "Continue", or "Review" on the last decision of a set with a check
  step. In a set of one, the button reads "Nothing to send" and is disabled.
  The decisions a _Send_ is writing count as waiting until its results
  show, because the write's own refetch lands first.
- A set with no provisional decisions shows "Nothing waits on you here" and a
  link back to the page.

### The surface

- The walkthrough covers the whole console at every width: no top bar, no
  sidebar. It is a layer over the page it opened on. The console beneath is
  inert while the layer is open, so focus and the screen reader stay in the
  walkthrough.
- Its header shows the delivery's title and id, or "Decisions without a
  delivery" and the project key, then the progress as "N of M", or "Check
  and send" on the check step. On a phone the segmented bar under the header
  shows the progress instead, and the progress text is left to a screen
  reader, so the title has the header's width and may take a second line. Close is an icon button named "Close the
  walkthrough". Close leaves the mode and shows the page; the browser's
  Back returns to the history entry before the walkthrough, which is the page when
  the walkthrough opened from it. Both keep the answers chosen so far
  (_Drafts_) and ask nothing. Leaving while _Send_ is writing does not stop
  the write; the next opening shows what landed.
- The offline notice shows at the top of the layer, and toasts show above it;
  on a phone a toast sits 8 below the layer's header, as it sits below the
  console's top bar.
- When a change removes the focused control and focus falls to the page body,
  focus moves to the screen's heading except while a commit runs. The
  walkthrough's note, which a layout switch remounts as it crosses `md`, keeps
  focus (MMR-770); its footer buttons do not yet (MMR-784).
- The layer uses the console's tokens, so both themes apply.

### A step

Each decision reads as the agent's briefing, top to bottom:

- A meta line: the agent mark and "Agent", the decision's class, its age, and
  its id.
- The question, as the step's heading.
- `It took <taken option> and kept building.`, with the option's text in
  bold. When the recommendation differs from the answer taken, it adds
  `It recommends <recommended option>.`
- The why, when the decision has one.
- The answers, a radio group named "Your answer to KEY-qN": one row per
  option, in order, with the option's full text. The taken option is flagged
  "Agent's answer" and the recommended one, when it differs, "Agent
  recommends". The taken option is selected on arrival, unless a draft holds
  another answer.
- A last row, "Something else", opens a box for an answer outside the list.
  While it is selected, the box holds the answer, which may not be blank, and
  the note box is hidden. The answer is sent as the overturn's note, with no
  option.
- "Built on this answer": the linked tasks, each with its id and title. A
  delivery's walkthrough takes titles from the delivery's members and a
  project's from the project's tree; a task in neither shows its id alone.

### The reply bar

The reply bar sits at the bottom of the step. On a phone the effect line
comes first, then the note box on its own row when shown, then Back and the
step's button together. On desktop the effect line sits above a single row
with Back, the note box when shown, and the step's button, in that order.

- **The effect line**, which follows the selected answer. For the taken
  option: `Confirming changes nothing.`, followed by `<ids> stay as built.`
  (`stays` for one task) when tasks are linked. For another option:
  `Overturning sends <ids> back for rework.` For _Something else_:
  `Your answer overturns this decision and sends <ids> back for rework.`
  With no linked tasks, these read `Overturning records this answer.` and
  `Your answer overturns this decision.`
- **The note box**, "Add a note for the agent (optional)", hidden while
  _Something else_ is selected. The note is the outcome note of a confirm,
  or the note of an overturn to another option. The walkthrough allows an
  overturn to an option with a note, which ADR 0043 allows. This replaces
  the MMR-695 refinement's "The console leaves that out" for the
  walkthrough; the chips still leave it out.
- **Back**, an icon button, disabled on the first step.
- **The step's button**, the surface's one solid action. Its label follows
  the selected answer: "Confirm and continue", "Overturn and continue", or
  "Use my answer and continue". On the last decision, "continue" reads
  "review". It moves to the next step and writes nothing.

The note box and the _Something else_ box start one line tall, grow with
their text to four lines, then scroll. They do this with `field-sizing:
content` and a four-line maximum height, and a script sets the height where
the browser lacks `field-sizing`.

### Check and Send

- After the last decision comes the check step, "Check your answers". It
  lists each decision's question, its outcome ("Confirmed" or "Overturned")
  with the answer, the note, and its effect (`Nothing to redo` or
  `Redoes <ids>`), with a _Change_ link that returns to that step.
- A line under the list says what _Send_ does:
  `Sending records every answer and wakes the agent on <delivery> once if any answer overturns.`
  A project's walkthrough says `Sending records every answer.`
- **Send N answers** writes them with `answerDecisions` ([ADR 0040](0040-outbound-integrations-and-host-secrets.md),
  MMR-703 refinement), in the set's order. N counts the decisions that still
  wait on the operator.
- While a blank _Something else_ waits, _Send_ is disabled and a muted line
  beside it says why:
  `Write your own answer to "<question>", or pick another answer, before sending.`
- **With one decision there is no check step.** The step's button commits
  directly and reads "Confirm and send", "Overturn and send", or "Send my
  answer".
- Nothing is written before _Send_. A write in flight disables _Send_, Back,
  _Change_, and Close, and _Send_ (or the one-decision commit) reads
  "Sending…" until it settles. Offline disables _Send_ and the one-decision
  commit. Moving between steps still works.
- _Continue_, _Review_, _Send_, _Change_, Back, and the rail entries ignore
  the second click of a double click. Answer rows also ignore it so a
  double click on _Change_ keeps the selected answer.

### After Send

The done screen replaces the steps. Its heading is "Answers sent" for a
delivery and "Answers recorded" for a project. Under it:

- What was recorded, and the tasks sent back for rework.
- Each refused or failed answer, with its question and the reason. A
  decision that is still provisional appears in the next opening, with its
  draft; one answered elsewhere does not.
- The next set waiting: the first decision in the review read's `queue`, the
  needs-you order across projects that the focus queue uses, whose set
  differs from this one. It reads
  `<delivery id> has N decisions for you`, or for a project's decisions
  without a delivery `<project key> has N decisions without a delivery`,
  with _Review them_, which opens that walkthrough. N counts that set's rows
  in the review read.
- A link back to the page the walkthrough opened on.

The wake state shows as the MMR-695 refinement shows it for every waking
function.

### Drafts

- Each decision's selected answer, its _Something else_ text, and its note
  are kept in the browser's local storage under the decision's id as they
  change, and are restored when the walkthrough opens again.
- A draft is removed when its answer is recorded. A refused or failed answer
  keeps its draft. A draft whose decision is no longer in the set when the
  walkthrough opens is removed.
- A draft never sends by itself; only _Send_ writes. ADR 0013's rule of no
  offline write queue holds.
- Storage that is missing or refuses a write is ignored: the walkthrough
  works without drafts.
- An opening starts at the first decision. The rail marks a decision answered
  once the operator moves past it in this opening, whatever its draft holds.

### Focus

- When a step, the check step, or the done screen shows, focus moves to its
  heading, which takes focus for this. It never lands on the step's button,
  _Send_, or the one-decision commit, so a key held down or pressed twice
  writes nothing.
- A _Send_ that fails shows its error as a toast, as the MMR-695
  refinement's refusals do, and returns focus to _Send_ or the one-decision
  commit once the write ends, when focus was lost with it.
- The answers are a native radio group: the arrow keys move the selection.
- The answer group's accessible name includes the decision's id. The step
  button's accessible name includes the id except while it writes, when
  its name is "Sending…".

### Phone and desktop

- At the `md` breakpoint and up, a rail beside the steps lists the set: an
  answered decision shows a check, its outcome, and its answer, and opens its
  step again; the current one is marked in attention violet; later ones are
  dimmed and disabled. The last entry is the check step, when there is one.
- Below `md`, a segmented bar under the header shows the progress, and the
  rail is hidden.
- Controls take the 44px phone touch target.
- Attention violet marks the agent's answer and its flag, and the current
  step; the "Agent recommends" flag is dim ink. "Confirmed" takes the `done`
  green and "Overturned" the `in_progress` amber, the hue of work sent back.

## Refinement (2026-11-18, MMR-704): opening the walkthrough

The MMR-703 refinement defines the decisions walkthrough and its address.
This refinement adds the links that open it, called entries here.
The MMR-695 chips stay on every decision row, so a quick confirm stays one
tap.

### The entries

An entry is a link that opens one set's walkthrough at its first decision,
the oldest one waiting, as the MMR-703 refinement orders a set.

- **In the Needs you popover and on the review page,** each project group
  shows its entries directly under the project heading, before the rows. It
  shows one entry for each delivery that has a provisional decision in the
  group, then one for the group's decisions that name no delivery. The
  delivery entries follow the needs-you order of each delivery's first
  decision row, and the no-delivery entry comes last. A group with no
  decision rows shows no entries.
- **On the delivery page,** the _Needs you_ section shows one entry above
  its decision rows when the delivery has a provisional decision.
- Copy, with N counting the set's decision rows in the read the surface
  shows:
  - a delivery in a project group: `Review N decisions on KEY-dN`, or
    `Review 1 decision on KEY-dN`;
  - no delivery in a project group: `Review N decisions without a
    delivery`, or `Review 1 decision without a delivery`;
  - on the delivery page: `Review N decisions`, or `Review 1 decision`.
- N counts the read, not the opening. A set of more than 100 decisions
  opens with its oldest 100, as the MMR-703 refinement caps an opening, and
  the rest wait for the next opening, where the entry counts them again.
  This is accepted: a set that large is rare.
- An entry targets `/p/KEY/dN?mode=decisions` for a delivery and
  `/p/KEY?mode=decisions` for decisions without a delivery.
- An entry is a text link in the attention hue, because the set is in the
  needs-you set. On a phone, it takes the 44px touch target. Activating an
  entry in the popover closes the popover, as every link in it does.
- The focus queue, a work page's needs-you group, and the T3 wake gain no
  entry. A work page's delivery row links to the delivery page, which has
  one. The wake goes to the agent after the operator has answered, so it
  keeps the ids-only message of
  [ADR 0040](0040-outbound-integrations-and-host-secrets.md).

### Leaving a walkthrough an entry opened

This replaces the MMR-703 refinement's rule that Close "leaves the mode and
shows the page" for a walkthrough an entry opened. That rule still holds
for every other opening.

- An entry opens the walkthrough as a new history entry and marks that
  history entry as opened in-app, in its history state. The mark records
  the path of the page the entry was on, the opener. It survives a reload,
  as history state does.
- On a walkthrough so marked, Close goes back one history entry, so the
  page the entry was on shows again. When that page is the walkthrough's
  own page, this keeps MMR-703's rule that Back returns to the history entry
  before the walkthrough. A replace would leave two copies of the page in
  history, and the next Back would seem to do nothing.
- A walkthrough opened any other way carries no mark: by an address typed
  or followed from outside the console, or in a new tab. The done screen's
  link to the next set passes on the mark it found, as below. On a
  walkthrough without a mark, Close replaces the history entry with the
  page without the mode, as the console does today.
- The done screen's and the empty state's link back to the page the
  walkthrough opened on keep their label and target, the walkthrough's own
  page, for every opening. This revises the MMR-703 refinement, whose link
  pushes a new history entry:
  - on a marked walkthrough whose opener is the walkthrough's own page,
    the link goes back one history entry, as Close does;
  - otherwise the link replaces the walkthrough's history entry with the
    page without the mode.

  Either way, Back from that page returns to where the operator was before
  the walkthrough and does not reopen it. It meets no second copy of the
  page unless the operator typed the walkthrough's address while already on
  its page, an unmarked opening the console cannot tell apart from a deep
  link. That case keeps the MMR-703 behavior and is accepted.
- The done screen's link to the next set replaces the walkthrough's history
  entry with the next set's walkthrough, and carries the walkthrough's mark,
  with its opener, over to it, or no mark when it had none. This revises
  the MMR-703 refinement, whose link pushes. A chain of walkthroughs then
  holds one history entry and keeps the first one's opener, so leaving the
  last one never reopens an earlier one or meets a second copy of a page.
- Scroll is not restored. The console restores no scroll position on any
  navigation, and this refinement adds none.

### The done screen

This revises the MMR-703 refinement's link copy. The done screen's link to
the next set reads _Review them_, or _Review it_ when that set holds one
decision.

## Refinement (2026-11-18, MMR-705): an option's detail in the walkthrough

ADR 0043's MMR-705 refinement lets an agent give an option a detail. The
walkthrough shows it. No other surface does.

- A detail sits under its option's text in the answers group, in a smaller,
  dim type. Its line breaks show.
- The detail stays out of the radio's accessible name. The whole row stays
  one label, so tapping anywhere on it, the detail included, selects its
  option, as a row without a detail does. The radio takes its name from the
  option's text and flags alone (`aria-labelledby`), and the detail is tied
  to it with `aria-describedby`, so a screen reader reads the detail after
  the name. A radio without a detail has no `aria-describedby`.
- A flag beside an option reads after a comma in the radio's name:
  "Remove, Agent recommends". This corrects the MMR-703 walkthrough, whose
  name ran the option's text into its flag, and applies to every option,
  with or without a detail.
- A detail clamps to two lines below the `md` breakpoint and to three at
  `md` and up, ending in an ellipsis. The selected answer's detail shows in
  full, so the operator reads all of what they pick. Moving the selection
  reflows the rows. This is accepted, because selecting writes nothing and
  the operator can read any detail by selecting it.
- An option without a detail reads as it did before this refinement,
  apart from the comma before its flag.
- The briefing line that names the taken and recommended options, the rail,
  the check step, the done screen, and the decision rows and chips show no
  details.

## Refinement (2026-11-19, MMR-714): focus after leaving the walkthrough

The MMR-704 refinement's Close, and its link back when that goes back,
return to the opener by going back one history entry. When the opener is
another page, that page renders anew, so the element that had focus is gone
and focus fell to the document. This refinement places it.

- The mark also names the control that takes focus back. For an entry on a
  page, that is the entry itself, named by its set: a delivery, or a
  project's decisions without a delivery. Every entry in the _Needs you_
  popover or sheet names the _Needs you_ alert instead, because the popover
  is closed by the time the walkthrough closes. The done screen's link to
  the next set carries the name over with the opener.
- When Close or the link back goes back one history entry, focus lands on
  the named control once the opener page shows. When the back lands on any
  other page, because Forward cut it short or the history before the
  walkthrough is not the opener, focus does not move, and the request is
  dropped.
- When the named control is gone, focus lands on the page's main region,
  made focusable if the page has not marked it so, as the skip link does.
  The entry is gone when the operator answered its whole set. The alert is
  gone when nothing needs the operator any more. A mark written before
  this refinement names no control, so focus lands on the main region.
- The walkthrough's dialog keeps its own focus return, which goes back to
  the element that had focus before it opened while that element is still
  on the page. On the walkthrough's own page that is the same entry, so the
  browser's own Back returns focus there as before. Back leaves no focus
  request, so it never moves focus to the main region.
- A walkthrough without a mark is unchanged: Close replaces its history
  entry and leaves focus to the dialog.

## Refinement (2026-11-19, MMR-734): one shape for a yes-or-no ask

A yes-or-no ask uses `ConfirmCard` (`components/ui/confirm-card.tsx`): a
title, a sentence or two on what the choice means, an optional answer line, and
a confirm beside its way out, the way out first.

- **Two surfaces.** `bare` is the body of a Sheet, Dialog, or Popover, whose
  title component names the dialog. `card` stands on a page as a region named
  by its title. A confirm of an action stays a modal dialog, as above, so it
  uses `bare`. `card` is only for a suggestion the page offers, such as the
  review page's notifications card, never for confirming a destructive
  action.
- **Buttons.** The confirm defaults to the solid action and the way out to an
  outline. A destructive confirm passes the destructive outline. A card on a
  page that already has its one solid button passes an outline confirm.
- **The answer line** is bright ink at medium weight, in a polite live region.
  It never takes the attention violet, which stays with the needs-you set.
- **Density** follows the surface: `default` on a card, `sm` in a sheet or
  dialog footer.

The push key reset sheet uses it. Moving the stop-run dialog and the inline
Unpair confirm onto it waits on a set of input patterns chosen by the kind of
input (MMR-736).

## Refinement (2026-11-20, MMR-736): patterns chosen by the kind of input

Features build from a fixed set of patterns over UI SDK primitives
([ADR 0046](0046-console-primitives-on-ui-sdk.md)). A new ask picks its
pattern by the kind of input it needs. A shape that no pattern provides is
added here first. The console readability phase (MMR-717) rebuilds the
console's feeds and record pages on these patterns. The inventory attached to
MMR-736 maps each of the console's asks to the task that moves it. The
mapping of every existing ask to its pattern is below, under _What this
replaces_.

### Surfaces

What a surface holds decides which one is used:

- **Dialog**: a question, modal. It is centred at every width. The one
  exception is the Walkthrough, a Dialog that covers the whole console at
  every width, as the MMR-703 refinement set out.
- **Sheet**: content or a form. It is UI SDK's Drawer: below `md`, a sheet
  from the bottom (full screen for a form); from `md` up, a panel from the
  right, 440px for content and 640px for a form. A Sheet is modal, with one
  exception (2026-11-22, MMR-720): the preview panel is non-modal from `md`
  up, a Drawer with `modal={false}` and no scrim, and modal below `md`.
- **Popup**: a short list anchored to its button, either a menu or a
  picker's results.

An **Action menu** opens in a Sheet below `md` (rows 44px tall, ending in a
Cancel row) and as an anchored menu from `md` up. The pattern makes that
switch, so no feature builds both shapes. A feature whose trigger changes
shape with the width, such as a row that is a full-width button on a phone,
switches it at the same `md`. An action that ends or removes something wears
the MMR-635 red hairline in both shapes. When the row that holds the menu
leaves, at once or after a refetch, and focus would fall to the page body,
focus moves on to the next control on the page, else the page's `<main>`
(2026-11-24, MMR-767). A caller that says where focus goes (`finalFocus`)
keeps its own rule. This is a second rule beside the MMR-474 row handoff;
which one the console keeps is an open design pass.

### The patterns

| Pattern | For | Surface | Primitives |
| --- | --- | --- | --- |
| Destructive confirm | an action that ends or removes something and cannot be undone | Dialog | Alert Dialog, with `ConfirmCard`'s `bare` body |
| Reason | an action that takes words before it runs: optional, or required; one commit, or two where a dialog offers two answers | Dialog | Dialog, Field, Textarea |
| Choice | one or several values from a fixed set | inline | Segmented Control, Radio, Select, Checkbox, Switch |
| Record picker | a record found by search | Popup; a Dialog for the jump palette | Combobox, Listbox, Command |
| Form sheet | creating or editing a record, with several fields | Sheet | Drawer, Field, Input, Textarea, Token Input, with Choice and Record picker |
| Content sheet | a record's or a row's content and settings that apply as they change, closed by Done or the caller's own actions | Sheet, 440 from `md` up | Drawer |
| Preview panel | a feed card's key facts, its one action, and Open, opened by the card's tap (MMR-720) | Sheet, 440 from `md` up and non-modal there; a modal bottom sheet below `md` | Drawer |
| Composer | text added in place, such as an annotation | inline | Textarea |
| Action menu | a list of actions, including a record's More | Popup, or a Sheet below `md` | Menu, Drawer, Separator, Radio |
| Suggestion | a one-time offer on a page | card | `ConfirmCard`'s `card` surface |
| Notice | an outcome whose ask has closed, optionally with Undo or Retry, and one second action; or a standing state | Toast; a banner for a standing state | Toast |
| Walkthrough | a guided series of answers | Dialog, whole console | Dialog, Radio, Textarea |

Plain parts in `components/ui` that wrap no UI SDK behavior (`ActionButton`,
`IconButton`, `Badge`, `Card`, the icons, and `Skeleton`) are no pattern.
Features use them directly, for a one-tap action such as _Approve_, _Turn on_,
or _Resume_.

### When an action asks first

The first rule that fits decides:

1. **A setting the same control turns back is a Choice.** It applies at once
   and asks nothing. A notification kind's Switch is one.
2. **An answer chip that names exactly what it commits is its own confirm.**
   A decision's _Confirm N_ and _Take M_ chips stay one tap, with the MMR-695
   refinement's focus rules. They are `ActionButton` chips, not a Choice.
3. **An action that takes words asks through Reason**, and Reason is its
   confirm. Parking, blocking, abandoning, returning, and pausing or
   abandoning a delivery use it.
4. **An action the operator can undo runs at once** and offers its undo:
   Undo in a Notice, as archiving a project does, or the reverse action in
   the same place, as Turn off offers Turn on (ADR 0045's MMR-711
   refinement).
5. **An action that ends or removes something and cannot be undone asks
   through Destructive confirm.** Stopping an agent run, unpairing a device,
   denying a pairing request, resetting the push key, and removing another
   browser are such actions. Denying a pairing request and removing another
   browser gain this confirm here. The MMR-635 red hairline stays on each
   control and on the confirm's commit.
6. **Anything else runs at once.**

No confirm expands in place, as the MMR-635 refinement already required. The
inline Unpair swap on Settings › Devices moves to Destructive confirm.

### Forms

- **One form for each kind of record**, used to create and to edit, always in
  the Form sheet. The kinds are task, phase, and initiative (one form);
  seed; project; and a T3 launch. A Dialog never holds a form of several
  fields. Reason's one field is not a form.
- **Seed capture is the seed form in the Form sheet.** It keeps the `s`
  hotkey and Enter to file.
- **A container's Direction is a field of its form**, not a dialog of its own.

### Choice

- **Segmented Control** holds a few one-word options that fit on one row,
  such as a task's size and priority, a seed's kind, and the theme.
- **Radio** holds options that need a label of more than a word.
- **Select** holds a longer fixed list, such as T3's models.
- **Checkbox** holds several independent values.
- **Switch** holds a setting that applies as soon as it changes.
- **A record is never a Choice.** A project or a parent is picked with the
  Record picker.
- **An Action menu may hold one Choice**, such as the theme in the top bar's
  _More_, shown as a group of menu radio items. Choosing it keeps the menu
  open, as the update action does (ADR 0013's MMR-715 refinement).

### Outcomes

An outcome shows where its ask was while that ask is still on screen:
`ConfirmCard`'s answer line, the sentence under the Notifications control
(ADR 0045's MMR-711 refinement), or a row's own result. An outcome whose ask
has closed is a Notice. A refusal that the MMR-695 refinement sends to a toast
stays a toast.

### Feed blocks

These building blocks of the readability phase (MMR-717) build on primitives:

- The preview panel, the Form sheet, and the filter sheet use Drawer.
- The day fold uses Collapsible.
- The record header's tabs use Tabs.
- The sidebar is a left Drawer below 1024 (`DESKTOP` in `routes/shell.tsx`), on a phone and on a narrow desktop alike (MMR-720).
- The phone Needs you deck uses `SwipeTrack`, a primitive over UI SDK's
  `bindDrag`, because Carousel did not fit (MMR-721 refinement, Considered
  and rejected).

The card, row group, section head, quiet line, and Shipped summary are plain
markup over the tokens and need no headless part.

### What this replaces

Each existing ask's pattern:

| Ask | Pattern |
| --- | --- |
| Stop run dialog | Destructive confirm |
| Reason dialog (node verbs, seed reject, resolve, and park, delivery pause and abandon) | Reason |
| Decision note dialog (MMR-695's _Confirm with note_ and _Answer with note_) | Reason, with two commits |
| Move dialog | The Parent field of the task form, a Record picker |
| Grooming dialog, set mode | A Choice (Radio) and a note field in the task form |
| Grooming dialog, answer mode | Reason, required |
| _Direction_ dialog | A field of the container's form |
| Seed capture dialog | The seed form in the Form sheet |
| T3 launch dialog | The T3 launch form in the Form sheet |
| Push key reset sheet | Destructive confirm |
| Inline Unpair confirm | Destructive confirm |
| Another browser's sheet and menu | Action menu |
| Jump palette | Record picker in a Dialog |
| Project picker, Home picker, depends-on field | Record picker |
| Task and seed edit forms, authoring sheet, promote sheet, new project and project settings sheets | Form sheet, one form per kind |
| Top-bar _More_ and T3's launch menu | Action menu |
| Toasts (Sonner) and the update and offline banners | Notice |

It also changes these accepted passages:

- **The MMR-734 refinement's surfaces.** `ConfirmCard`'s `bare` surface is now
  the body of Destructive confirm, so the push key reset leaves its sheet.
  The `card` surface is the Suggestion pattern alone.
- **The MMR-635 refinement's list.** _Deny_ on `/pair` and _Remove this
  browser_ now ask through Destructive confirm, and _Remove this browser_'s
  sheet and menu are the Action menu pattern.
- **The MMR-703 refinement's "The answers are a native radio group".** They
  are UI SDK's Radio, which keeps the arrow keys moving the selection.
- **ADR 0038's inline Unpair confirm.** _Unpair_ on the devices page now asks
  through Destructive confirm, and _Deny_ on `/pair` gains one.
- **The MMR-492 _Needs you_ popover and phone sheet** stay until the Needs you
  page (MMR-723) replaces them. They take no new pattern.

## Refinement (2026-11-20, MMR-712): the Switch of the Choice pattern

The Notifications page's kinds (ADR 0045's MMR-712 refinement) are the first
Switch of the MMR-736 refinement's Choice pattern: a setting that applies as
soon as it changes and asks nothing. This refinement adds how the Switch
looks and behaves while it saves.

- **The row.** The setting's name is the row's text, and a `<label>` wraps it
  and the switch, so the name labels the switch and a tap on the text flips
  it. The row is at least 44 pixels tall on a phone.
- **The switch** is 40 by 24 pixels: accent when on, and faint ink when off,
  at least 3:1 against the card in both themes.
- **While it saves,** the switch shows its new position and is disabled. A
  failure returns it to the saved position and says why in a polite line
  under its group.
- **The primitive.** The Switch is UI SDK's, styled in `components/ui/switch.tsx`
  (ADR 0046), and the notification kinds use it.
- **Not for an action.** A choice whose outcome is not known until a prompt or
  a call answers stays a button that names the action, as Turn on does (ADR
  0045's MMR-711 and MMR-736 refinements).

## Refinement (2026-11-21, MMR-743): a form's choices, the Content sheet, and the switcher

The Form sheet (MMR-743) settles three questions the MMR-626 and MMR-736
refinements left open, and records two exceptions.

- **A form's Segmented Control selects with the accent.** A selected segment
  is the `accent/12` wash with a 1px `accent` inset ring (§1 and DESIGN.md,
  Color roles), as the seed form's Kind and Launch in T3's options draw.
  This replaces the MMR-626 refinement's neutral selected pill for a form,
  and its test clause for the seed capture: the seed form's test fails if a
  selected kind carries a `status-` class or loses the accent wash. The
  authoring sheet's priority pills keep the neutral `line` fill until
  MMR-731 moves the authoring sheet onto the Segmented Control.
- **Workspace stays a Segmented Control.** Launch in T3's Workspace offers
  "Project checkout" and "New worktree", labels longer than a word, which the
  MMR-736 refinement's Choice gives to a Radio. It stays a Segmented Control,
  as in the source mock: its two options fit one row at every width, and it
  sits under Advanced among other one-row choices. A third option, or a label
  that wraps, moves it to a Radio.
- **The Content sheet is a pattern.** A Sheet that holds content rather
  than a form, 440 wide from `md` up and from the bottom below it, takes the
  row added to the patterns table above. It shows a record's or a row's
  content and settings that apply as they change, so it asks nothing; one
  Done closes it unless the caller gives its own footer actions, and its
  title may set a key in mono. Another browser's notification kinds are the
  first: their switches are hairline-separated rows on the sheet, since a
  group is never a card inside a sheet. Its sides keep the Form sheet's
  padding, 20 on a phone and 32 from `md` up.
- **The project switcher is a temporary exception.** It is the Record
  picker's popup (`RecordPickerPopup`) holding its own listbox, with its
  pins, archive fold, and All projects row on its own keyboard model, not
  Combobox and Listbox as the patterns table gives a Record picker. MMR-730
  converges it onto Combobox and Listbox; until then its group headings use
  the menu group heading (13/20, ink-dim, sentence case) so it reads as the
  other pickers do.

## Refinement (2026-11-22, MMR-718): readable type, and the status word in bright ink

Measured on a phone on 2026-11-18: meta lines and IDs at 11.5px and
timestamps at 10.5px, all in `ink-faint`, which measures 3.4:1 on the dark
page (`well-900`) and 2.6:1 on the light one, below AA's 4.5:1. Row titles
were 14px at regular weight, the same as body text, so a feed's titles did
not lead. Status words carried their hue as text, so the grey statuses were
the hardest to read: `parked` measures 2.5:1 and `abandoned` 1.8:1 against a
dark card (`well-850`), and `abandoned` 3.9:1 on a light one, in a 10.5px
uppercase pill, and lower still on the 12% wash the pill sat on.

- **Nothing that carries information is under 12px.** `text-tag` and
  `text-micro` rise to 12px. `text-mono-id` rises to 12.5px, for an ID that
  stands alone in a row's ID column, half a step under the meta line so it
  does not compete with the title beside it. An ID that shares a line with
  sans text, a meta line or a header's status line, takes that line's 13px,
  as DESIGN.md's mono rule says. Decoration (a grip, a separator dot) is
  exempt.
- **Text that carries information is `ink-dim` or brighter.** `ink-faint`
  and `ink-ghost` draw only what carries no information: a control's edge, an
  off switch, a grip, a separator, a disabled glyph. This ends DESIGN.md's
  standing exemption for the authoring sheet's and pairing's `ink-ghost`
  placeholders: they draw in `ink-dim`, as a search box's does.
- **Demotion stops at `ink-dim`.** §7's demotion still drops ink: a demoted
  row's title (a done, abandoned, or going-cold row) draws in `ink-dim`, the
  demoted ink MMR-619 names, and no text drops below it. A status word never
  drops an ink tier; the offline page's filter (§7) is a separate demotion.
- **Titles lead.** A row or card title in a feed is 16px at weight 500 in
  `ink-bright` (`text-title`), at every width; it replaces the phone-only
  15px `text-card-mobile`. Its meta line is 13px `ink-dim` (`text-meta`).
- **The microlabel stays the one all-caps idiom (§6), at 12px.** It is
  600-weight, tracked 0.1em (from 0.13em, which spread a 12px word too far),
  and `ink-dim` or brighter. Whether feed sections keep it is MMR-719's
  section head.
- **A status word is bright; only its dot carries the hue.** A status reads
  as its dot in the status hue followed by its display label (In progress,
  not `in_progress`) in `ink-bright`, semibold, 13px, with no wash and no
  ring. On a record
  header the status leads the line, then a hairline, then the record's ID
  and type in `ink-dim`. This narrows §1's "tinted chips" and §3's "chips"
  for status: dots, card borders, and bar segments keep the hue, and a
  status no longer renders as a tinted chip. The MMR-438 refinement's red
  for an external block, and every later hue on a status word, sit on the
  dot. Every status word then measures 13.6:1 or better on every well in
  both themes, `parked` and `abandoned` included.
- **Words beside a status follow it.** A seed's lane reads the same way: a
  dot in the lane's hue, then its word in bright semibold ink, leading the
  seed's header line; the seeds list's lane group headers draw in dim ink,
  as the tasks list's status groups do. A held task's callout keeps its hued wash and edge,
  and its label reads in `ink-bright`. A delivery's lifecycle and hold words
  and an artifact's frozen mark are not status words (MMR-680), so they keep
  their ink chips and their place on the line.
- **Considered and rejected.** Brightening `ink-faint` until it passes 4.5:1:
  one token change, but `ink-faint` would become a second `ink-dim`, and
  every control edge and grip that uses it would brighten with it. Keeping
  the tinted pill with a bright word: the wash still carries the hue, so the
  word and its ground disagree. Sentence-case section headings in place of
  the microlabel: a better read in the mocks, but they belong to MMR-719's
  section head, so they wait for it.
- `packages/host/src/test/readable-type.test.tsx` fails if a `--text-*`
  token under the floor returns, in any unit; if a styles.css rule sets a
  `font-size` or `font` shorthand under 12px, applies faint text or an
  undersized size, or sets faint ink as a text colour; and if a console
  source draws faint text outside its listed decoration uses (as the
  utility, the `text-(--…)`, `text-[var(…)]`, or `[color:var(…)]` form, an
  inline style, or a Typography text variable) or a literal size under 12px
  (in a `text-[…]` utility, a `[font-size:…]` property, or an inline style;
  in px, rem, em, pt, a keyword, or an unreadable `calc()`). An em size is
  read against the 13px meta base, so a relative size inside a smaller
  parent needs a `max()` floor, as the Markdown body's do. Its
  status-word cases fail if the shared status word part (`StatusWord`, which
  `StatusBadge` and the lane badge use) takes a status hue, and the work,
  seed, artifact, and delivery page tests each check that the word they
  render is that bright part.

## Refinement (2026-11-22, MMR-719): the feed blocks

The readability phase (MMR-717, design of record in artifact MMR-a420)
rebuilds the console's feeds from shared blocks. This refinement records six
of them: the section head, the card, the row group, the day fold, the
Shipped summary, and the quiet line and quiet sentence. The Needs you deck
(MMR-721) and the preview panel (MMR-720) are recorded by their own tasks.
The six live together in `components/patterns/feed`, so a page assembles
them rather than drawing its own. Like the other patterns, they import
primitives only, and a feature hands them its own parts (a status badge, a
chip) through slots. The operator picked their form from the third round of
mocks, after blind design review of each round (MMR-719: chips on their own
row, and 15px heads). `packages/host/DESIGN.md` holds their numbers.

The blocks change no page by themselves. The task that rebuilds a page
decides which blocks it takes (Home in MMR-722, the Needs you page in
MMR-723, list pages in MMR-724, scoped pages in MMR-727), and until then
ADR 0013's section rules (Shipped as rows grouped by day among them) and the
needs-you rows of the MMR-694 and MMR-695 refinements stand. A decision's
row keeps its answer chips: the feed card's one-button limit binds feed
cards, not those rows or the focus queue's card.

- **A feed section's head is a sentence-case heading, not the microlabel.**
  It reads as the section's name in 15px/600 `ink-bright`, followed by its
  count in 13px `ink-dim` inside the same heading, and ends in an optional
  _See all_ link at the right. Its row is 44px tall on a phone, with or
  without the link, so every section starts at the same distance from its
  head. This narrows §6: the microlabel stays the one all-caps idiom, for
  column and lane captions, and no longer captions a feed section. The
  MMR-718 refinement left that choice to this block.
- **A feed card is one target, with at most one button stacked over it.** It reads
  top down: a status line, the title (16px/500, `text-title`), an optional
  detail line (13px `ink-dim`, two lines at most), an optional chip row, and
  an optional button. The status line leads with what the item is and the
  record's ID, and keeps the age
  at its right end on the first line. Each part of the line moves to the
  next line whole. A status's dot and word never part (status words are a
  closed set of short words); a long name after them, such as a project's,
  wraps rather than run past the card. A task's card leads with its status badge. A card that stands for
  a set of provisional decisions (one delivery's, or a project's decisions
  without a delivery, as the phase design bundles them) leads with the word
  _Decisions_ after an attention dot, set as a status word is (13px,
  semibold, `ink-bright`); it names a set, not a delivery's lifecycle, so
  MMR-680's ink chips do not apply to it. (2026-11-23, MMR-721: a stopped
  delivery's card leads with _Stopped_ after an attention dot, set the same
  way. 2026-11-23, MMR-752: in the Needs you deck, a task that needs answers
  leads with _Question_ after an attention dot, set the same way.) Which ID such a card shows and
  where its preview's Open leads are settled by the MMR-721 refinement below. Chips (size, grooming, stale) sit in their own row under the title,
  never on the status line, so a long title never leaves a chip alone on a
  line. The whole card is one stretched target whose accessible description
  is its status line and chip row. Its one button is stacked over that
  target as a separate target, so a tap beside the button still reaches the
  card. The stretched target was a link to the record's page until MMR-720
  made it a button that opens the card's preview (the MMR-720 refinement
  below); the preview's Open reaches the record's page.
  A going-cold card's title is demoted to `ink-dim` (§7, MMR-718).
- **A row group is a list of doors.** Each row is one link, at least 44px
  tall on a phone and 36px on desktop: an optional key in a mono column of
  fixed minimum width, a name (16px/500, two lines at most), and a count.
  A row whose count is zero is left out. When the group is capped, its last
  row is a link of the same shape ("5 more projects") that opens the list
  page with a filter set (principles 2 and 6 of MMR-a420). (2026-11-23,
  MMR-722: a row with no destination is a plain row, and a group may stand
  framed; see the MMR-722 refinement below.)
- **A day fold is a disclosure built on Collapsible.** Its trigger is a row
  44px tall on a phone and 36px on desktop: a chevron that points right when
  closed and down when open, the day in 14px/500 sans `ink`, and the
  day's count. It opens and closes at once, without the primitive's height
  animation or chevron turn, within §8's motion budget. Days run newest
  first, as do the rows within a day, and only the latest day starts open. Inside it, finished work is rows, each a link: the
  status dot, the title demoted to `ink-dim` (§7, MMR-718), and the time in
  mono. An abandoned row adds a second line with its status word in bright
  ink and its reason, and every row's status is in its accessible text. A
  day with more rows than its cap (the caller's to set) ends in a _Show N
  more_ button that reveals the rest in place and moves focus to the first
  revealed row. (2026-11-24, MMR-761: a row that holds focus stays shown when
  a refetch pushes it past the cap, until focus leaves the day's rows and its
  _Show N more_ or a refetch drops the row.) (2026-11-24, MMR-779: below `md` a finished title takes up to
  two lines; from `md` up it keeps one.)
- **The Shipped summary is a seven-day column chart, then a row group.**
  Each day is one column, with its count above the bar and its short name
  below, and all columns share one baseline. Any day above zero draws at
  least 4px, so a smaller day never draws taller than a larger one. Bars
  draw in the `done` hue, as §1 keeps hues on bar segments. Today's bar is partial, so it is outlined in
  the `done` hue over a weaker fill and labelled "so far". The chart's
  accessible name lists every day's count. Counts past 999 are shortened on
  screen to four characters (1.2k, 12k, 1.2M, 1B), so on a 320px phone a
  label stays within its column and the gaps beside it and never touches a
  neighbour, and stay exact in the accessible name. A row group of
  counts one level down follows the chart.
- **Quiet states are plain sentences.** A quiet line replaces one empty
  section with a sentence ("Nothing needs you."). A quiet sentence replaces
  the rest of a page's empty sections with one sentence. Both are body text
  in `ink`, with no frame: a card reads as something to tap, and a quiet
  state offers nothing to tap. This departs from MMR-a420's block table,
  which offered "one card" for the quiet sentence.
- **Considered and rejected.**
  - Chips on the status line: it kept a card a line shorter, but at 320px
    the chips wrapped and pushed the line to two rows.
  - Keeping the microlabel for section heads: at 12px `ink-dim` it was the
    faintest text in the section it headed.
  - A 16px/600 head: on a scoped page it sat one pixel under the 17px/600
    record title above it.
  - A list chart of horizontal bars: it took 180px against the columns'
    110px.
  - A framed quiet card: it read as tappable.
- `packages/host/src/test/feed-blocks.test.tsx` checks each block's
  behavior: the head's count and link; the card's single link
  and separate button, and its description; the row group's door; the fold's
  disclosure, focus after _Show N more_, and only the latest day open; and
  the chart's accessible name, shortened counts, and partial day. The
  readable-type guard covers their type and ink; sizes and wrapping are
  checked in a real browser, as jsdom has no layout.

## Refinement (2026-11-22, MMR-720): the preview panel

Tapping a feed card opens its preview (principle 4 of MMR-a420). The
**preview panel** is a pattern in `components/patterns/feed`, built on Drawer
beside the MMR-719 blocks. On a phone it shows as a bottom sheet, and on
desktop as a panel from the right. A feature hands it the record's facts, the
card's action, and Open through slots, so the pattern reads no data of its
own. The operator picked its form from the third round of mocks, after blind
design review of each round (MMR-720). `packages/host/DESIGN.md` holds its
numbers, under Feed blocks.

The preview panel changes no page by itself: `/kit` shows it with sample
data, and each page task from MMR-722 on passes the facts its feed already
has. It keeps no URL state. Back does not close it, no link opens it, and
Open navigates to the record's page.

- **A preview offers no action the card does not.** It shows the card's status
  line and title, the facts that matter, the card's one action, and Open
  (MMR-a420's principle 4). It adds no third action, and it does not show the record's
  full description: Open reaches the record's page for the rest.
- **On desktop the panel is non-modal.** A 440 panel slides in from the
  right, starting at the top bar's measured bottom (`--top-bar-height`), so
  the bar's Needs you alert and More stay in reach. It is a Drawer with
  `modal={false}`: unlike the Content sheet, it draws no scrim and leaves the
  feed usable, because the feed stays live beside it and clicking another
  card switches the preview to that card. A non-modal Drawer closes on an
  outside press only with `closeOnOutsidePress`, so the click rules below
  are the pattern's to apply. This is the one non-modal Sheet (the Sheet
  surface and the patterns table above). On a switch the selected card's
  ring moves, the panel's content changes in place at once, and its body
  scrolls back to the top.
- **The card's tap is a button that opens the preview.** The stretched
  target that MMR-719 made a link becomes a button with
  `aria-haspopup="dialog"`, because a tap no longer navigates. Open in the
  preview panel is the link to the record's page.
- **Focus moves to the panel, but on desktop no trap holds it there.**
  Opening or switching moves focus to the panel's title, so a screen reader
  announces the record. The title shows a ring only for keyboard focus
  (`:focus-visible`). Close follows the title in tab order. Shift+Tab from the title goes back
  to the selected card,
  and Tab from the panel's last button goes on to the control after the
  selected card's stretched target: its own button when it has one, else the
  next card. Escape closes the topmost layer first: an open menu, the jump palette, or
  the sidebar drawer before the panel, and the panel from the panel or the
  feed. Closing
  returns focus to the card that opened the latest preview: a switch makes
  the newly clicked card the opener. On a phone the bottom sheet sits over a
  scrim, so it is a modal Drawer like any other sheet and holds focus until
  it closes. When the card's action leaves the panel for another surface, as
  a bundle's walkthrough does, the panel closes and that surface's opener is
  the selected card's own button, so focus returns there as the MMR-714
  refinement describes.
- **What a click does while the panel is open.** Clicking the selected card
  closes the panel. Clicking another card switches it, but clicking that
  card's button runs the button's action. See all, a sidebar link, or
  a top-bar control that navigates closes the panel as it navigates. Clicking empty feed space closes it.
- **The desktop layout makes room for the panel in three ranges.** The
  console's sidebar sits beside the page from 1024 (`DESKTOP` in
  `routes/shell.tsx`) and is a drawer below it.
  - From 768 to 1023 there is no sidebar column. The panel sits beside the
    feed, and the feed's columns follow the container rule below.
  - From 1024 to 1599 the 256 sidebar yields while the panel is open: it
    slides out with the panel and comes back when the panel closes. At 1280,
    keeping the sidebar would leave the feed 584 beside the panel, one
    column; without it the feed has 840, two columns.
  - From 1600 up the sidebar stays, and the feed column re-centres 220 to
    the left, half the panel's width, in step with the panel's slide, and
    moves back as the panel closes.
- **A feed's columns follow its own width, not the viewport's.** From `md`
  up, a card grid shows two columns only when two cards of 300 or more fit:
  612 of grid, or 652 of room with the column's 20 gutters. This changes the
  MMR-719 refinement's card grid, which turned two columns at `md`:
  `CardGrid`'s `md:grid-cols-2` becomes a container query. A closed feed
  keeps two columns at every desktop width, since 768 without a sidebar
  column and 1024 beside it both leave a 728 grid. An open feed is one
  column from 768 to 1091 and two from 1092. At 1024 the `md` rule would
  have drawn two cards of 266 beside the panel.
- **The selected card stays in view.** A reflow on open, switch, or close can
  move the selected card, as when two columns become one. After any such
  reflow, the selected card scrolls into view, at once rather than smoothly. The feed and the panel scroll
  separately.
- **The footer is Open, then the card's action.** Open is always an outline,
  and it stands alone when the card has no button. The card's action follows
  it as the panel's one solid button, even where the card draws that action
  as an outline (a task's Answer). The panel is its own surface, so its
  solid action may stand beside a feed that shows its own one solid button.
- **The body opens with the reason the item is here.** Under the header's
  status line and title, the body opens with the reason, in complete
  sentences, then the facts as a definition list. A task's reason says what
  it waits on ("Needs an answer before it can start.", then the question). A
  seed's reason is its card's detail sentence, followed by its text in 14px
  `ink`, cut at the end of a sentence. A decision bundle's reason is "This
  delivery has N provisional decisions." (for a project's decisions without
  a delivery, "This project has N provisional decisions without a
  delivery."); its facts name the affected tasks, and the delivery or
  project where the header does not already name it. It does not list the
  decisions, which the walkthrough holds. A relation (a parent, a
  dependency, a bundle's task) is plain text, its ID and title, not a link.
  No fact repeats the status line, so there is no Lane, Project, or Oldest
  row: the status line already shows a seed's lane, a bundle's project, and
  the age.
- **The card whose preview is open is selected.** Its fill takes a 7%
  `accent` wash mixed into `well-850`, lighter than a selected segment's
  `accent/12`, and its 1px edge turns `accent`, as a selected segment's ring
  is. The ring moves when the preview switches. The card's outline button
  takes an `ink-dim` edge, since its `ink-faint` edge falls under 3:1 on the
  wash.
- **On a phone the preview panel is a bottom sheet that fits its content.**
  It grows with its content up to 88% of the visible viewport, over a tappable scrim.
  The grip, the header with Close centred on the status line, and the footer
  stay put, and only the body scrolls. The footer splits into two equal
  tracks, so a long action label wraps inside its button instead of
  squeezing Open. Each button is 44 or taller, and the footer pads for the
  safe area. When the body continues under the footer, a cue shows it.
  Swipe-down closes the sheet only when the body is scrolled to its top;
  elsewhere the gesture scrolls the body. The sheet's top seam is one named
  token, `sheet-seam`, that clears 3:1 against the rendered scrim in both
  themes. `ink-faint`, which DESIGN.md gave the Select bottom list's seam,
  measures under 3:1 against the light scrim, so the Select bottom list
  takes the same token.
- **The panel moves as §8 now states.** §8's panel slide includes the
  sidebar's exit and return and the feed column's re-centre that travel with it (the
  2026-11-22 amendment to §8). A switch adds no cross-fade, which would be a
  fourth mover (now a fifth). Under `prefers-reduced-motion` the panel does not slide: the
  panel, the sidebar, and the feed column change at once.
- **Considered and rejected.**
  - A scrim on desktop, as the Content sheet draws: a click on another card
    would land on the scrim and close the panel instead of switching it.
  - The record's full description in the body: the preview shows the facts
    that matter, and Open reaches the rest.
  - A third action in the footer: the preview never offers more than the
    card (MMR-a420's principle 4).
  - A cross-fade on switch, which round 3's mock drew: it would add a fourth
    mover (now a fifth) to §8's exhaustive budget.
  - A list of a bundle's decisions: the walkthrough holds them, and the
    bundle's action opens it.

## Refinement (2026-11-23, MMR-721): the needs-you set shows as a deck of cards

The **Needs you deck** shows the needs-you set as feed cards (the MMR-719
refinement), one ranked list across projects, paged rather than listed in
full. It is a pattern in `components/patterns/feed` beside the MMR-719
blocks and the MMR-720 preview panel, with a module that turns the set's rows
into cards, previews, and actions. The operator picked its form, variant A,
from three deck mocks; two rounds of blind design review then iterated it
to a score of 9 from both reviewers (MMR-721).
`packages/host/DESIGN.md` holds its numbers, under Feed blocks.

The deck changes no page by itself: `/kit` shows it with sample data, and
Home (MMR-722) mounts it as its one ranked deck across projects. The Needs
you page (MMR-723) stays grouped by project and decides how it reuses these
cards and bundles within its project groups. Until then, the needs-you rows
of the MMR-694 and MMR-695 refinements stand on every page that shows them,
with their answer chips.

### One order, bundled

- **One ranked order across projects.** The deck uses the needs-you set's
  order of the MMR-694 refinement and drops its project grouping, as the
  focus queue does. The review report's `queue` already walks every member
  in that order across projects; the deck follows it and takes each
  member's row from its project's `needsYou` group. The first card is the
  set's first record, from any project.
- **A provisional decision shows in a bundle, not alone.** A delivery's
  provisional decisions make one card, and a project's decisions that name
  no delivery make one card per project, the sets of the MMR-704 entries.
  Every bundle takes the place of its first decision in the order. Unlike
  MMR-704's entries, which put the no-delivery entry last in its group, a
  project's bundle takes its first decision's place too. A stopped delivery
  and its own decisions are two cards, each in its own place.
- **The deck's count counts cards, not records.** The section head's count
  and the pager's N are the number of cards, because the pager moves through
  cards and its N must match the head. The MMR-476 refinement's "One set,
  one count", which MMR-694 keeps, binds the counts of the set's records:
  the alert, the review page's title, and the project list still count
  records and still agree with each other. The deck is a view that bundles
  the set, so its head counts what it shows, and each bundle's button names
  how many decisions it holds, so no record is out of sight. On a page that
  shows both, the alert and the deck's head can read different numbers.
  (2026-11-23, MMR-722: on Home the head reads both counts, "N cards, M
  items", the second the alert's; see the MMR-722 refinement below. Home's
  page title names the day and carries no count.)

### The cards

Every card is the MMR-719 feed card and opens its preview (MMR-720). Each
card's button is an outline, the feed card's own, never a solid and never
the attention outline of the MMR-695 rows: the attention dot or status
badge already marks the card, and a solid on a lower card out-pulled the
higher ones. The preview carries the card's one solid action (MMR-720).

- **A delivery's bundle** leads with an attention dot and _Decisions_
  (MMR-719), then the delivery's ID (`KEY-dN`) and the project's name, and
  the age of its first decision in the order. Its title is the delivery's
  title. Its detail counts the distinct tasks its decisions link that are
  not `abandoned`: "Across 4 tasks." ("Across 1 task."), or "No work is
  built on them yet." when there are none. Its button, _Review N decisions_
  (_Review 1 decision_), opens the delivery's walkthrough as the MMR-704
  entry does, and its accessible name adds the set: "Review 3 decisions on
  FLT-d2". Its preview's reason is "This delivery has N provisional
  decisions.", its facts are Tasks (the tasks the detail counts) and Phase,
  and Open goes to the delivery's page ("Open FLT-d2").
- **A project's bundle** leads the same way, then the project's key in mono
  and its name. Its title reads "Mimir decisions without a delivery", in the
  MMR-704 entry's words. This amends the reviewed mock, which read "outside
  a delivery": the title, the button, and the entries keep one phrase. Its
  detail, button, and preview follow the
  delivery's bundle; the button's accessible name reads "Review 4 decisions
  without a delivery in MMR"; the preview's reason is "This project has N
  provisional decisions without a delivery."; its only fact is Tasks, left
  out when the bundle links no tasks, and it has no Phase fact; and Open
  goes to the project's page, named "Open MMR", the name `openName` in
  `preview-panel.tsx` derives from the key the header shows.
- **A stopped delivery** leads with an attention dot and _Stopped_, set as a
  status word, then its ID and the project's name, and the age of its
  `updated_at`. Its detail is its stop reason, two lines at most. Its
  button, _Clear stop_, is the delivery page's write (MMR-695), from the
  same waking function, so it wakes the delivery's thread as the page does.
  This amends the MMR-695 refinement's rule that a stopped delivery's row
  elsewhere carries no verbs: the deck's card carries _Clear stop_, and the
  delivery's needs-you rows elsewhere still carry none. Its preview's
  reason is the stop reason's first sentence, and the rest of the reason
  follows in full, so the operator reads why it stopped before clearing it.
  When the same delivery's decisions are in the set, a _Decisions_ fact
  says so: "3 decisions on this delivery are waiting. They are their own
  card in Needs you." Its other fact is the phase. Open goes to the
  delivery's page. This card and the same delivery's bundle are two cards
  with two identities (The deck's state).
- **A task that needs answers** leads with an attention dot and
  _Question_, set as a status word, then its ID, as the _Stopped_ and
  _Decisions_ cards lead; its preview's status line leads the same way. It
  shows its question as the detail and carries _Answer…_, which opens the
  existing answer dialog unchanged (`GroomingAnswerDialog`). It carries no
  _Needs answers_ chip, since the lead already says why it is here. Its
  preview is otherwise the MMR-720 task preview. (2026-11-23, MMR-752: this
  replaces the status badge and chip the card first led with. The lead is
  the deck's alone: a task's card in Now or a list keeps its status badge
  and grooming chip.)
- **A task blocked on you** leads with its status badge and shows its block
  reason as the detail. It has no button, so in a grid row it keeps the
  room at its foot (MMR-719). Its preview opens with "Blocked on you." in
  600, then the reason, and its footer holds Open alone.
- **Detail copy amends the mock** as the project bundle's title does. The
  reviewed mock wrote each detail as a sentence of its own ("Choices the
  agent made before the delivery stopped, across 4 tasks.", "4 choices
  recorded with no delivery and no live task built on them.", "Blocked on
  you: approve the notarization account…"). No record holds such
  sentences, so a bundle's detail is the count "Across N tasks." or "No
  work is built on them yet.", and a blocked card's detail is its block
  reason alone, since its status badge already says it is blocked.

### Where each field comes from

The deck reads the review report (`ReviewReport`) and adds one field to it,
beside `needsYou`. That field is additive: core joins it from the existing
delivery records, phase nodes, and task nodes, and the store does not
change. It holds an entry for each delivery the deck shows, that is each
delivery a bundle's decisions name and each stopped delivery: the
delivery's title, its phase's ID, and the phase's title joined from the
phase node. It also holds, for each bundle, the distinct tasks its
decisions link that are not `abandoned`, by the test core's `workBuiltOnIt`
applies to each decision's tasks.

- **Project name:** the review report's `projects`, by the row's project
  key. A key missing there shows alone.
- **Phase:** both kinds of delivery card name the phase the same way, from
  the new field: its title, or its ID when no title is available.
- **A delivery's bundle:** its title comes from the new field. Without an
  entry, the title reads "Decisions on FLT-d2" and the Phase fact is left
  out. The detail's count and the Tasks fact come from the new field's
  tasks for the bundle. The Tasks fact lists them by ID alone. The age is
  the first decision's `created_at`.
- **A stopped delivery:** its title, stop reason (`hold_reason`), project,
  and `updated_at` come from its own needs-you row (`kind: 'delivery'`);
  that row carries the phase's ID only, and the phase's title comes from
  the new field. A stop with no reason shows no detail line, and its
  preview's reason reads "This delivery is stopped."
- **A task:** its `NodeView`; the question is the row's `question`, and the
  block reason is the task's `holdReason`. Either one missing leaves the
  detail line out.
- **Not shown:** the reviewed mock's Time fact ("4h 02m of a 4h cap") and
  its In flight fact, a stopped delivery's task in flight. The delivery
  page's dossier (`deliveryPage`) carries the time as `elapsed_minutes` and
  `time_cap_minutes`, which the review report omits, and the deck does not
  fetch a dossier for each delivery. The review report's `now` rows carry
  in-flight tasks as `NodeView`s with their titles, but the deck does not
  read them: it shows linked tasks by ID and omits In flight.

### The phone deck

Below 768 the deck shows one card at a time.

- The current card sits at the page's 14 gutter, and the next card's first
  38 peeks at the screen's right edge, in full ink. Every card takes the
  height of the deck's tallest card, so the pager never moves as the deck
  turns.
- **The peeking card is out of reach of focus and screen readers.** It is
  out of the tab order and `aria-hidden`, but it is not given the HTML
  `inert` attribute, which would swallow the tap: a tap anywhere on it turns
  the deck to it and never presses its button or opens its preview. Its tap
  target takes in the 8 gap before it, so it is 46 wide while 38 shows,
  meeting the 44 minimum for a phone's tap targets.
- **Swipe** turns the deck: the card follows the finger, the position
  changes once the card passes halfway, and the deck rests on one card, at
  most one card per swipe. A mostly vertical gesture scrolls the page.
- **A swipe or a tap on the peek moves focus with the turn,** as every turn
  does (The deck's state), so focus never stays on a card that is off
  screen or `aria-hidden`.
- **The pager** sits centred under the deck: a Previous arrow, the position
  "1 of 10", and a Next arrow. The arrows are named "Previous card" and
  "Next card". At an end, the arrow is disabled but keeps focus
  (`aria-disabled`), so focus never drops to the page.
- **Arrow keys.** With focus anywhere in the deck, Left and Right turn one
  card. Focus on the old card moves to the new card's target; focus on an
  arrow stays there. Each card is a group named by its position ("2 of 10"),
  and a turn announces the incoming card once: a live announcement when
  focus stays outside the incoming card, as on an arrow, and none when
  focus moves into it, since the screen reader reads the card's group as
  focus enters it.
- **At the last card** the card stays at the gutter, with nothing peeking
  and the space at its right empty; Next is disabled.
- **A single card** fills the width between the gutters, with no peek and
  no pager.
- The deck's position is not kept in the URL. The deck starts at its first
  card on initial mount, except on a walkthrough's return (The deck's
  state).

### The desktop deck

From 768 the deck shows a page of four cards in the Card grid of the
MMR-720 refinement: two by two at two columns, and four stacked when the grid
is one column, as beside an open preview panel from 768 to 1091.

- **Paging moves four cards.** The range "1–4 of 10" and the arrows,
  "Previous page" and "Next page", sit in the section head, left of _See
  all_. When the head cannot hold them on one line, as in the 288 column
  beside the panel at 768, the range and arrows move together to a line of
  their own under the name, at the right. The head then grows by that line,
  a second row as tall as the arrows, and keeps its 12 to the cards.
- **Every page holds one grid height.** When the deck has more than one
  page, each page takes two rows of the deck's tallest card (four rows in
  one column), so a short last page keeps its height and the section below
  never moves between pages. A deck of one page draws only its own rows.
- **Arrow keys.** With focus in the deck, Left and Right turn one page.
  Focus on a card moves to the first card's target on the new page; focus
  on an arrow stays there. Each card is a group named by its position ("5 of 10"), and
  a page turn announces the new range once ("5–8 of 10"). A page turns at
  once, without a slide.
- A deck of four cards or fewer shows no range or arrows.

### The deck's state

These rules hold on both decks unless they name one. They form one model:
the deck holds one current card by its identity; the phone always shows
that card, and desktop shows the page that holds it only while the card is
anchored; focus moves only when the element holding it goes; and anything
that moves focus into the deck first brings its card into view.

**Which card is current**

- **Every card has one identity, never its index:** a task's ID, a stopped
  delivery's ID, or a bundle's set, `delivery:FLT-d2` or `project:MMR`
  (the names `entryName` in `decisions-entry.tsx` gives). A stopped
  delivery's card and that delivery's bundle are two identities, `FLT-d2`
  and `delivery:FLT-d2`, so one leaving never moves the other.
- **The deck keeps one current card.** A turn makes the incoming card
  current: on the phone an arrow, a key, a swipe, or a tap on the peek; on
  desktop a page turn makes the new page's first card current. Focus
  entering a card makes it current, and so does opening its preview or
  switching the preview to it. The preview rule also covers a click that
  does not focus the button, as in Safari.
- **What is shown follows the current card.** The phone always shows the
  current card, wherever a refetch moves it. On desktop the current card is
  anchored while a card holds focus or has the open preview: the page shown
  is then the one that holds it, page ⌊k/4⌋ for the card at index k,
  counted from 0. While nothing anchors it, the next refetch keeps desktop's
  page number, clamped to the last page when the deck shrinks, and the page
  refills from its neighbours; the shown page's first card then becomes
  current. Releasing focus alone changes no current card. A change of
  page the operator did not make, by an anchored card moving to another
  page or by the clamp, announces the new range as a page turn does.
- **Focus outranks the preview as an anchor.** When focus is on one card
  while another card's preview is open, the focused card is current and
  desktop shows the page that holds it. The open preview closes if its card
  is no longer on the shown page, and focus stays on the focused card.
- **Crossing 768 never changes the current card,** anchored or not: a
  crossing is neither a turn nor a leave. Desktop shows the page that holds
  the current card, and the phone shows that card.

**Cards that leave or arrive**

- **A card leaves when its record leaves the set,** and only then: when a
  refetch drops it, including the refetch after a cleared stop or an answer
  on the deck. A refetch can also add and reorder cards; the deck applies
  it by identity, by the rules above, and focus stays on the element that
  holds it whenever that element survives. A refetch that arrives during a
  swipe applies once the swipe settles.
- **When the current card leaves, its successor becomes current:** the
  nearest card after it in the old order that is still in the deck, or,
  with none after it, the nearest card before it. The phone shows the
  successor in the same place, or moves back one. On desktop the successor
  rule applies only to an anchored deck, which shows the page that holds
  the successor.
- **An unanchored desktop deck keeps its page.** When a refetch changes
  the shown page's cards with no card focused and no preview open, only the rule that keeps the page number applies: the page is
  clamped and refilled, its first card becomes current, and a last page
  left empty turns back one.
- **When no old card survives a refetch but cards remain,** on the phone
  and on an anchored desktop deck the new card at the old current card's
  former index, clamped to the new last card, becomes current, and focus
  that was in the deck moves to its target. An unanchored desktop deck
  keeps its page by the rule above. The quiet line comes only when no card
  remains.
- **A card that leaves while it holds no focus moves no focus.** When
  _Clear stop_ on card 2 succeeds after the operator moved on to card 5,
  the phone keeps showing card 5 and focus stays where it is. On desktop,
  with focus on Next, the second page keeps its place and refills, so it
  now starts at the card that was 6th; with focus on card 5, the first
  page, which now holds card 5, shows and its range is announced.

**Where focus goes**

- **Focus moves from a card that left to its successor's target,** when it
  was in that card, in its preview, or in a dialog opened from it: the
  stretched target that opens its preview, never its button, so a key held
  down writes nothing, as the MMR-695 refinement keeps focus off committing
  chips.
- **Every turn moves focus held in the outgoing card.** A turn by any
  means, a key, a swipe, a tap on the peek, or a pointer click on a pager
  arrow (which Safari does not focus), moves focus held in the outgoing
  card to the incoming card's target; on desktop that is the target of the
  new page's first card. A desktop page turn also closes the open preview
  (The preview follows its card), and focus that was in it moves the same
  way.
- **A deck control that unmounts hands focus on.** A pager control that
  holds focus keeps it while it survives, as an arrow at an end does. A
  pager unmounts when the deck drops to one card on the phone or four on
  desktop, and when the viewport crosses 768, which swaps the phone's pager
  for the head's; focus on it then moves to the current card's target.
- **With no card left, focus goes to the quiet line.** Whenever an update
  removes the element holding focus in the deck, in its preview, or in a
  dialog opened from it, and no card remains, the quiet line "Nothing needs
  you." takes the section's place (MMR-719) and takes focus, made focusable
  for it. So when the last card's _Clear stop_ succeeds from its preview's
  footer, focus goes to the quiet line.
- **Focus never falls to the page body,** and never stays on a card that is
  off screen, on another page, peeking, or `aria-hidden`. Anything that
  moves focus into the deck turns the deck to that card first, at once:
  the rules above, a swipe or a tap on the peek, the answer dialog's
  return, and a walkthrough's return.

**Previews, writes, and the answer dialog**

- **The preview follows its card.** Opening a preview or switching it makes
  its card current, so the shown page follows it. When the previewed card
  leaves, the preview closes and focus follows the rules above rather than
  returning to the card. On desktop a page turn closes the open preview;
  focus stays on an arrow that took it, and otherwise follows the turn
  rule above. On the phone the preview's bottom sheet is modal: the deck
  takes no swipe or key until the sheet is dismissed.
- **A write in flight** marks that card's button and its preview's footer
  action, which are one write, `aria-disabled` rather than natively
  disabled, so focus stays on the pressed control; the other cards stay
  live. A preview stays open while a write from its footer is in flight,
  but the operator may still turn the page, close the preview, or switch it
  to another card, and the write goes on. When the write settles, it never
  moves focus that has left that card and its preview. On success the card
  leaves only if the refreshed set drops it. A refused write shows its
  toast and the card stays (MMR-695); focus returns to the pressed control
  only when focus is still in that card or its preview.
- **The answer dialog** (`GroomingAnswerDialog`) opens from the card's
  _Answer…_ or its preview's footer. An answer can keep the task at
  `needs_answers`, which the dialog offers as a choice; its note then
  becomes the task's latest question. So the card leaves only when the
  refreshed set drops it; otherwise it stays and its question updates in
  place. The dialog closes once the refetched records render, and focus is
  resolved after it closes. While the card survives, focus goes to the
  card's own _Answer…_ button from either entry point: the MMR-720 preview
  closes when its footer action runs and hands the card's button on as the
  opener. When that button no longer exists, as when the task was blocked
  meanwhile, focus goes to the card's stretched target. When the card is
  gone, the rules for a card that left apply. A refused answer keeps the
  dialog open with its draft.

**A walkthrough's return**

- **The deck is asked before the page.** A bundle's button is the return
  target the MMR-714 refinement names, by its set's name. Today
  `lib/walkthrough-mark.ts` resolves a return with `document.querySelector`
  on `data-walkthrough-return` and falls back to `focusMain()`, so it would
  miss a bundle on another page or behind the peek. The deck registers its
  sets with the opener-focus request, a change to `lib/walkthrough-mark.ts`
  in this task, so the request asks the deck before it queries the
  document. The name matches bundle cards only, never a stopped delivery's
  card. When the bundle is in the deck, wherever it sits, its card becomes
  current, the deck turns to it at once, and then focus lands on its
  button. When it is gone, the document query and then the MMR-714
  refinement's fallback hold: focus lands on the page's main region, also
  when the deck is now empty.

**Offline** disables both of a card's write entry points, its button and
its preview's footer action, for _Clear stop_ and _Answer…_ on every card
(ADR 0013 §5). They are `aria-disabled`, still focusable and doing nothing,
as a write in flight marks them, and never natively disabled, so focus on
one survives going offline. _Review N decisions_ stays live: it opens the
walkthrough, which is navigation, not a write, and the walkthrough's own
writes follow ADR 0013 there. An answer dialog already open when the
connection drops keeps its draft, and its _Answer_ commit is
`aria-disabled` and guarded while offline, so nothing queues for
reconnect. `GroomingAnswerDialog` has no such guard today; adding it is a
change to `components/grooming-answer-dialog.tsx` in this task.

### Edges

- **An empty set** shows the quiet line "Nothing needs you." in the
  section's place, with no head, as the MMR-719 refinement gives every
  empty feed section.
- **A three-digit total** keeps the pager still: the numbers are tabular,
  and the phone's position holds the width of the total's digits for the
  index, so the arrows never shift as the index grows. The desktop range
  reserves the width of both its numbers at the total's digit count before
  the head decides whether the pager wraps, so a page turn never makes it
  wrap. Counts are exact.
- **Long names at 320** wrap as the MMR-719 card's status line does; the
  phone card is 260 wide there.

### Motion

The phone deck's turn is a mover §8 now names (the 2026-11-23 amendment to
§8). A turn from an arrow, a key, or a tap on the peek slides the cards to
rest, with no overshoot; a swipe is the finger's own movement, and the deck
then settles on one card. When a card leaves, the phone's successor slides
into its place as a turn does. Under `prefers-reduced-motion`, a turn from
an arrow, a key, or a tap happens at once; a swipe may still track the
finger, but its settle and the reflow after a card leaves happen at once.
The deck moves by `SwipeTrack` (`components/ui/swipe-track.tsx`), a
primitive that follows the pointer with UI SDK's `bindDrag` and turns the
row with a transform; under reduced motion its transitions are off
(`motion-reduce:transition-none`), so a turn and a settle land at once. A
native scroll-snap settle would slide even under reduced motion.
The desktop deck never slides: a page turn, and a page refilling after a
card leaves, happen at once, so they add no motion.

### Considered and rejected

- **Project by project** (variant B): it kept each project's items together,
  but the first card was no longer the set's most urgent record.
- **Neighbours peeking on both sides** (variant C): centring the card left a
  narrower card, and the previous card showed from the second position on.
- **A solid button on each bundle:** DESIGN.md allows one solid per surface,
  and solids on lower bundles out-pulled the stops above them.
- **Collapsing a short last page:** the section below moved by a row between
  pages.
- **Counting records in the head:** the pager's N would not match it, and a
  bundle of 12 decisions would read as 12 of something the deck shows once.
- **UI SDK's `Carousel` for the phone deck:** it pages by native scroll
  snap and failed four checks. The last card rested at the end of the
  content (x=60 at 390), not on the 14 gutter. A mouse drag past either end
  sprang back. Its scroll-snap settle is the browser's own animation, which
  slides even under reduced motion. Its peek is `inert`, so a tap on it
  turns nothing. `SwipeTrack` replaces it (Motion).

## Refinement (2026-11-23, MMR-722): Home's options on the feed blocks

Home (ADR 0013, MMR-722 refinement) is the first page assembled from the
feed blocks. It adds four options to the blocks rather than new blocks.
`packages/host/DESIGN.md` holds their numbers, under Feed blocks.

- **A row with no destination is a plain row.** A row group's row takes an
  optional destination. Without one it is not a link: it draws the row's key,
  name, and count at the row's height, with no chevron and no hover fill,
  since a chevron promises a place to go. Home's rows have no destination
  until the MMR-724 list pages give See all and these rows somewhere to lead:
  Shipped's rows by project and the spare-minute rows.
- **A row group may stand framed.** A row group that is a section's whole
  block, not a part of another block, may sit in a card's frame (`well-850`,
  the card's `line` edge and 10 radius, 16 sides), so it matches the Shipped
  summary's card beside it on the page. This departs from DESIGN.md's row
  group, which is unframed rows, and seed MMR-s110 records the departure for
  the design system to settle. (2026-11-24, MMR-780: settled; the framed
  group is a named row group option, for a group that is a section's whole
  block beside a framed section.)
- **The deck's head can count records beside its cards.** A deck given the
  records its cards hold reads "N cards, M items" in its head: the cards, as
  the MMR-721 refinement counts them and the pager's N matches, then the
  records, the count the top-bar alert shows. Home's deck reads both; the
  deck elsewhere counts cards alone.
- **A capped section's head reads what shows of the whole.** A section head
  takes a count the caller words. Home's Now shows four cards on a phone and
  six from 768 and reads "6 of 9" (or "4 of 9") when the cap hides cards,
  and the plain count when every card shows.
- `packages/host/src/test/feed-blocks.test.tsx` checks the plain row, the
  frame, and a worded count; `feed-deck.test.tsx` the deck's two counts; and
  `home-page.test.tsx` how Home uses them.

## Refinement (2026-11-24, MMR-726): the record header, More, and the record tabs

Project, initiative, phase, and task pages open with one header, drawn by
the record header pattern (`components/patterns/record-header.tsx`), and the
three containers put everything else behind tabs, the record tabs pattern
(`components/patterns/record-tabs.tsx`) on the Tabs primitive.
The operator picked the form from three rounds of mocks after blind design
review (principles 8 and 9 of MMR-a420). `packages/host/DESIGN.md` holds the
numbers, under Record header. Seed, artifact, and delivery pages keep their
own heads until MMR-732 brings them onto the pattern.

- **The header says what the record is, in one order.** A quiet trail of the
  record's ancestors, outermost first, in one `ink-dim` line with no type
  labels and `ink-faint` slashes between them; then the title; then the
  status line; then the summary, clamped to three lines with a _more_ text
  button when it runs past them; then a chip row for what the summary
  leaves out (a task's grooming state, only before it starts); then the
  actions. A project heads its own trail, so it has none, and its
  description stands in for the summary it does not have. On a phone the
  trail folds the ancestors between the project and the parent into "…",
  which shows them; on desktop they give way first, each to 120px, then fold
  the same way, and the parent keeps its whole name until it alone
  overflows. The trail is the way up: the "↑" parent link it replaces is
  gone, and the trail draws no arrow.
- **The status line leads with the status, then the type, then the ID.** The
  status's dot and bright word (the MMR-718 rule), a `line-bright` hairline,
  then the type in words ("Task", "Project") and the ID in mono, both
  `ink-dim`. It is the feed card's status line with a type, so the header
  and a card read the same; the seed, artifact, and delivery heads keep the
  older ID-then-type line until MMR-732.
- **One main action, the rest under More.** The header offers the single
  action the record's state calls for, as the one solid button, and More
  beside it. A container's is New task, always. A task's is Start while it
  is ready; Approve and _Send back…_ (an outline) while it is in review; and
  nothing while an agent runs it, while it waits on others, or once it is
  finished, when More stands alone. The review's text stays in the task's
  body, without the verdict buttons it used to repeat. On desktop the
  actions sit beside the title while the title keeps at least 440px;
  otherwise, and always on a phone, they drop 16px below the summary.
- **More groups everything else, in four groups.** Edit, with Move… and
  Set grooming… beside it until the edit sheet folds them in (MMR-731); then
  the status changes, with the T3 rows after them where Start is offered
  and T3 is configured; then the holds (park, block, and their undoing);
  then _Abandon…_ alone, wearing the MMR-635 red hairline. A separator falls
  between two groups, and an empty group takes none. More is the Action
  menu as it ships (the MMR-736 refinement): an anchored menu from `md`, a
  bottom sheet with 44px rows and a Cancel row below it, headed by the
  record's title and ID, its top edge the `sheet-seam` with the light
  theme's upward shadow, as the preview sheet's. Offline, every row is disabled where it stands. A
  project's More holds Edit, which opens the project's settings, and _Edit
  direction…_; an initiative's or phase's holds _Edit direction…_. The
  task's Actions chip and its rail section are retired. The T3 rows replace
  the Launch in T3 split button and keep its one-click launch: a _Start on
  <System>_ row per catalog system, the system the defaults name first,
  launches with that system's defaults (or opens the settings form set to it
  when it has none) and is disabled for a system that cannot take the
  launch; _Start in T3…_ follows and opens the settings form at the
  remembered choice. A T3 state that cannot launch reads as one disabled row
  that says why.
- **An outline button on the page surface takes an `ink-dim` edge.**
  `ink-faint` measures 2.6:1 on `well-900` in light, under the 3:1 a
  control's edge needs, so More, _Send back…_, and every record page's phone chips
  draw their edge in `ink-dim` there. On a card or a sheet (`well-850`) an
  outline keeps `ink-faint`.
- **Tabs follow the header, Work first.** The Tabs primitive takes a 44 ×
  44 tap target below `md`, with its label at the left of its box so the
  first label sits on the page's gutter, and 36px tall from `md` with 20px
  between tabs. A row too wide for the screen scrolls sideways and is never
  clipped. The selected tab's 2px underline covers the row's hairline, which
  the row draws as an inset shadow: the scrolling row clips to its padding
  box, so a border under it cut the underline to 1px. A tab's count is 13px sans in `ink-dim`, a step under its label.
  Which tabs a page has, and how the URL holds the selected one, are ADR
  0013's (its MMR-726 refinement).
- `packages/host/src/test/record-header.test.tsx` checks the clamp, where
  the actions sit, and the desktop fold; `node-page.test.tsx`,
  `project-page.test.tsx`, and `work-page.test.tsx` check how the four
  record pages use the header, More, and the tabs.
