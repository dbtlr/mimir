# Console design guidelines

The measurable rules for building and reviewing console UI. [ADR 0019](../../docs/decisions/0019-meridian-console-design-system.md)
holds Meridian's semantic rules (what each hue means, the motion budget, the
pattern set); this file holds the numbers. Tokens live in
[`src/styles.css`](src/styles.css); primitives in [`src/components/ui`](src/components/ui).

Every value is marked:

- **existing**: in the code today; the source is cited.
- **adopted (MMR-…)**: proposed with that task's mock, approved with it,
  and now carried by the primitives and patterns (MMR-743 the Form sheet,
  MMR-718 readable type, MMR-719 the feed blocks, MMR-720 the preview
  panel). The reason given beside
  one says what the code did before.
- **proposed**: missing from or different in the code. Each carries a one-line
  reason and needs the operator's ruling before a primitive adopts it.

A screen that meets these numbers breathes. When in doubt, add space between
groups, not inside them: the label, control, and help of one field sit close;
fields and groups sit well apart.

## Type

Two voices, never mixed within a role (ADR 0019 §6). **Instrument Sans** for all
UI text and prose; **JetBrains Mono** only for machine vocabulary: IDs, keys,
branch names, timestamps-as-data. Both are self-hosted through Fontsource
(existing, `styles.css` imports). Sizes are rem against a 16px root (existing,
`html { font-size: 100% }`).

| Role | Size / line height | Weight | Ink | Token or class | Mark |
| --- | --- | --- | --- | --- | --- |
| Page title | 28 / 36 | 700 | ink-bright | `text-page` | existing |
| Section header on a page | 21 / 28, tracking -0.01em | 700 | ink-bright | `text-header` | existing |
| Sheet or Dialog title (a form) | 21 / 28, tracking -0.01em | 600 | ink-bright | `text-header` | **adopted (MMR-743)** in the Form sheet; a Dialog's question title keeps `OVERLAY_TITLE_CLASS` (14px) |
| Record title | 17 / 24 | 600 | ink-bright | `text-dossier` | existing |
| Preview panel title | 17 / 24 | 600 | ink-bright | `text-dossier` | **adopted (MMR-720)**: the Content sheet's title is 14 / 600 (`text-body`) |
| Section head in a feed (Needs you, Now) | 15 / 22 | 600 | ink-bright; its count 13 / 20 ink-dim inside the heading | `text-section` | **adopted (MMR-719)**: feed sections were headed by the 12px all-caps microlabel in ink-dim, the faintest text in the section |
| Row or card title in a feed | 16 / 22 | 500 | ink-bright | `text-title` | **adopted (MMR-718)**: rows were `text-body` (14, regular) and phone cards `text-card-mobile` (15); a title must lead its meta |
| Day label of a day fold | 14 / 20 | 500 | ink, one step above the ink-dim rows it heads; its count 13 / 20 ink-dim | `text-label` | **adopted (MMR-719)**: was 12px mono, a date is not machine vocabulary |
| Group heading inside a form (Advanced, Lifecycle) | 16 / 24 | 600 | ink-bright | `text-base` | **adopted (MMR-743)**: groups today use the 10.5px microlabel, under the floor |
| Control text (input value, option label, select value) | 15 / 22 | 400 | ink-bright | `text-[15px] leading-[22px]` (Input, Textarea) | existing |
| Field label | 14 / 20 | 500 | ink | `text-label` | **adopted (MMR-743)**: `FIELD_LABEL_CLASS` is 12px ink-dim; a label must read before its control |
| Body, prose | 14 / 23 (1.65) | 400 | ink | `text-body` | existing |
| Button label | 14 / 20 | 600 | per variant | `text-label` | size and weight existing (ActionButton `default`); the token **adopted (MMR-743)** |
| Help, context line, meta, a footer note, a group's explanation (Lifecycle) | 13 / 20, measure 440, `text-wrap: pretty` | 400 | ink-dim | `text-meta` | **adopted (MMR-743)** for help: `FieldDescription` is 12px ink-faint (2.6:1 on light) |
| Group heading inside a menu (a provider over its models) | 13 / 20 | 500 | ink-dim | `text-meta` | **adopted (MMR-743)** |
| Status word | 13 / 20 | 600 | ink-bright; the hue only on its dot | `text-meta` | **adopted (MMR-718)**: the word drew in its status hue on a 12% wash, uppercase at 10.5 on headers |
| Record ID or project key alone in a row's ID or key column | 12.5, on the row's line, mono | 400 | ink-dim | `text-mono-id` | **adopted (MMR-718)**: was 11.5 in ink-faint; an ID that shares a line with sans text (a meta line, a header's status line) takes the line's 13 |
| Microlabel (the one all-caps idiom) | 12, on its context's line; tracking 0.1em, uppercase | 600 | ink-dim or brighter | `.microlabel` (`text-micro`) | **adopted (MMR-718)**: was 10.5, tracked 0.13em, often ink-faint |
| Floor: tags, captions | 12 / 16 | 400–600 | ink-dim or brighter | `text-xs`, `text-tag` | **adopted (MMR-718)**: `text-tag` (11) and `text-micro` (10.5) rose to 12 |

`text-body` is one size with one line height: 14 / 23, for prose. A label is
not prose, so it gets its own token: `--text-label` (14px) with a paired 20px
line height, for a field label, a button label, a segment's text, a day
fold's label, and a text button such as _Show N more_ (**adopted
(MMR-743)**, `styles.css`; the last two MMR-719); `text-body` keeps 14 / 23 for body copy.

Rules:

- **Nothing that carries information is under 12px.** Decoration (a grip, a
  glyph) is exempt.
- **One step of difference at least** between neighboring roles: a label (14)
  never sits beside a help line (13) in the same ink and weight; the label
  is ink at 500, the help ink-dim at 400.
- **Sentence case everywhere.** The uppercase microlabel is the one all-caps
  idiom (ADR 0019 §6) and is for column and lane captions on dense feeds only,
  never in a form, never as a label. One exception: a value passed through
  from a provider keeps the provider's spelling. Reasoning effort reads
  `low`, `medium`, `high`, lowercase, in sans; a value is not recased to
  look like a label.
- **Measure.** Prose aims for about 70 characters a line; 70 is a target,
  not a hard limit. A form has one measure for all its prose: help text and
  a group's explanation (Lifecycle) both wrap at 440px (about 70 characters
  at 13px), set `text-wrap: pretty`, so one paragraph never wraps at a
  different width from the help above it. Under a narrow control, help still
  runs past the control's edge to that cap. A parenthetical list of examples
  stays on one line (`white-space: nowrap` from the word before it), so
  "every ID (`KEY-1`, `KEY-2`, …)" never splits; when the space runs out
  first, as on a phone, the run wraps whole onto the next line, and that
  line may pass 70.
- **No line of a paragraph is a single word.** Tune the measure until the
  last line holds a phrase, and check both widths.
- **Mono sizes match their neighbors on a shared line.** An ID inside a 13px meta line is 13px
  mono, not a smaller step. A mono value that stands apart on a title row
  never takes the title's size. A finished row's time is 13px, the meta
  size. An ID or project key alone in its column is 12.5px (`text-mono-id`).
- **A mono value beside sans matches its x-height.** JetBrains Mono's x-height
  is 0.55 of its size and Instrument Sans's 0.51, so at one size the mono
  reads larger. A mono value in a menu row or a control's value (a system,
  a model's identifier, a key) sets `font-size-adjust: var(--mono-adjust)`
  (0.51), and its x-height lands on the sans text around it.
- **A context line names what a mono value is.** A bare key reads as stray:
  write "Project key `MMR`", or put the record's title after its ID
  ("`MMR-743` Form sheet pattern"). The mono value takes the line's ink
  (`color: inherit`), in help text too.
- **Identifiers are mono wherever they appear,** a Select's value and a
  menu row included: a system (`asgard`), a key, a model shown by its
  identifier (`gpt-6.1-sol`). A name is sans: a model shown by its product
  name ("Sonnet 5.5"), a project's title. A Select shows what its source
  displays, so Launch in T3's Project reads "Mimir", the title, not the
  slug. A value that pairs a key with a title keeps the source's format, the
  key in mono and the title in sans: "`MMR` — Mimir".
- **Help that quotes the value being typed follows it.** The Key help shows
  `KEY-1, KEY-2, …` while the key is empty and the real key (`CRD-1`) once
  one exists.

## Color roles

Use roles, never raw hex. Dark is the default theme; light overrides the same
tokens under `[data-theme='light']` (existing, `styles.css`). Contrast figures
are measured against `well-850` / `well-900` / `well-950`.

| Role | Token | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| Primary text | `ink-bright` | 15.1 / 15.9 / 16.3 | 15.8 / 13.6 / 14.9 | titles, control values, headings |
| Body text | `ink` | 10.0 / 10.6 / 10.8 | 9.3 / 8.0 / 8.8 | prose, field labels |
| Secondary text | `ink-dim` | 6.6 / 7.0 / 7.2 | 5.5 / 4.8 / 5.2 | help, meta, context line, optional marker |
| Faint | `ink-faint` | 3.2 / 3.4 / 3.5 | 3.1 / 2.6 / 2.9 | non-text only: a control's edge, an off switch, a grip, a separator line that marks a value (the Shipped chart's baseline), disabled glyphs |
| Ghost | `ink-ghost` | 2.5 / 2.6 / 2.7 | 2.3 / 2.0 / 2.2 | decoration only, never placeholder ink (2.7:1 dark, 2.2:1 light on `well-950`); see the placeholder rule below. **Adopted (MMR-743)** in the text field and the search boxes of the Record picker and the jump palette; and, with MMR-744, the Composer and the Walkthrough's text boxes; the authoring sheet's and pairing's `ink-ghost` placeholders moved to `ink-dim` with MMR-718 |
| Accent | `accent`, `accent-foreground` | 8.7, 10.5 on 850 | 3.7, 6.8 on 850 | focus, selection washes and rings, links (`-foreground` as text) |
| Action | `action` / `action-foreground` | 8.0:1 | 9.5:1 | the one solid button per surface |
| Danger | `status-blocked-foreground` | 8.7 on 850 | 6.3 on 850 | error text, the destructive outline's label |
| Sheet seam | `sheet-seam` | `ink-dim`: 3.92–7.15 against the rendered scrim | `ink`: 4.38–7.29 against the rendered scrim | the top edge of a phone bottom sheet over the scrim: the preview panel's bottom sheet and a Select's bottom list. Its value was chosen by measurement against the rendered scrim (see Preview panel) |

All existing (`styles.css`), except `sheet-seam`, **adopted (MMR-720)**. Rules:

- **Text that carries information is `ink-dim` or brighter**: 4.5:1 or better
  on every well in both themes. `ink-faint` and `ink-ghost` never carry it
  (MMR-718).
- **A status word is `ink-bright`; only its dot carries the hue** (ADR 0019,
  MMR-718). The word is 13/20 semibold, sentence case, with no wash or ring,
  so the grey statuses read as well as the bright ones (`abandoned` as text
  measured 1.8:1 on a dark card). On a record header the status leads the
  line, then a `line-bright` hairline, then the ID and type in `ink-dim`.
- **Demotion stops at `ink-dim`.** A demoted row's title (done, abandoned,
  going cold) draws in `ink-dim`, never fainter; a status word never drops
  an ink tier.
- **A form field has no placeholder, and help text is only for a surprising
  input.** A field gets a help line only when it behaves in a way its label
  doesn't say, or needs a specific format: the seed's "First line is the
  title. Shift+Enter for a body line.", or the Key's "It can't change
  later". A prompt for what to write ("What is this project for?") gets
  neither a placeholder nor a help line; the label carries the field. Help
  is 13/20 `ink-dim` (6.6:1 dark, 5.5:1 light on `well-850`). Outside a
  form, where a placeholder remains (a search box), it is `ink-dim`: 7.2:1
  dark, 5.2:1 light on `well-950`.
- **A disabled commit is a quiet button, not a faded one.** Fill `well-800`,
  label `ink-dim` (6.4:1 dark, 5.1:1 light on `well-800`), and a 1px
  `ink-ghost` inset edge so the shape holds on a `well-850` footer (the
  fill alone differs by 1.04:1 dark, 1.08:1 light; a `line-bright` edge, 1.4:1,
  faded out on a phone's bottom bar, so the edge steps up to `ink-ghost`,
  about 2.5:1 dark and 2.2:1 light). Disabled controls are
  exempt from the 3:1 edge rule, but their label still meets 4.5:1
  (**adopted (MMR-743)**, `QUIET_DISABLED` in `action-button.tsx`; an
  outline button, a hairline already, still fades to 40%).
- **Surfaces, from deepest to most raised**: `well-950` (top bar, input
  ground), `well-900` (page), `well-850` (card, panel, menu), `well-800`
  (nested block). Depth is tone, not shadow, in dark; light adds the
  `shadow-card` / `shadow-menu` / `shadow-overlay` ramp (existing).
- **Form surfaces: the panel is `well-850` and a control's ground is
  `well-950`.** The Drawer's panel is `well-850` (**adopted (MMR-743)**).
  **Proposed**: the Dialog panel is `well-900` today, and a `well-950` input
  on `well-900` differs by under 2% luminance, so a control in a Dialog reads
  only by its edge.
- **The overlay scrim** is `well-950` at 70% with a 2px blur (existing,
  `OVERLAY_BACKDROP_CLASS`).
- **Control edges meet 3:1 against the surface they sit on.** Where the edge
  is what identifies the control (Input, Textarea, Select trigger, Segmented
  track, Combobox, a menu that floats over the sheet, an outline button), the
  edge is `ink-faint`: 3.2:1 on `well-850` in dark, 3.1:1 in light. Hover
  raises it to `ink-dim` (**adopted (MMR-743)**, `CONTROL_EDGE_CLASS`; the
  `line-bright` edge it replaced measured 1.4:1 dark and 1.5:1 light).
  Checkbox and radio boxes already use `ink-dim` (existing).
  `line` and `line-bright` stay for structure: rules, panel edges, a toast's
  edge, never the edge that tells you where to type.
- **Accent is a wash, never a surface fill.** A selected segment is
  `accent/12` with a 1px `accent` inset ring, inset 2px clear of the track's
  1px edge on every side, so the first and last segments never double the
  track border (wash existing,
  `segmented-control.tsx`; full-strength ring **adopted (MMR-743)**, because the
  `accent/24` ring is under 3:1 and the state must read without color hue
  alone). Two fills are sanctioned, and only these:
  - **`action`**, the one solid button per surface. In dark it is the same hex
    as `accent` on purpose: cyan is the console's single voice, and the commit
    is the one place it is solid. In light, `action` is slate (`#31485e`)
    while `accent` stays teal. A second solid on a surface is never accent.
  - **State marks under 20px**: a checked Checkbox box and a radio dot fill
    with `accent` (existing, `checkbox.tsx`).
- **Danger is a hairline, never a fill**: `DESTRUCTIVE_OUTLINE` (existing,
  `action-button.tsx`, ADR 0019 MMR-635). An action that removes nothing, such
  as Archive, is a neutral outline.

## Spacing

A 4px grid. The scale, in px: **4, 8, 12, 16, 20, 24, 32, 40**. 6 survives
only inside compact chips and menus (existing, `gap-1.5`); forms do not use it.

### A form

| Between | Value | Mark |
| --- | --- | --- |
| Label and its control | 8 | **adopted (MMR-743)**: `Field` is `gap-1.5` (6); a 14px label needs more air |
| Control and its help or error | 8 | **adopted (MMR-743)**: same reason |
| Label and the optional marker on its line | 8, baseline-aligned | **adopted (MMR-743)** |
| One field and the next | 24 | **adopted (MMR-743)**: today's sheets use 12–16, the measured cause of cramming |
| A lone checkbox row after a field | 24 from the control above to the row's text; the row's extra height is pulled back with a negative margin | **adopted (MMR-743)** |
| One group and the next | 32, a `line` hairline, then 24 | **adopted (MMR-743)** |
| Group heading (ink-bright 16/600) and its first label (ink 14/500) | 20, line box to line box. A collapsible heading is a 44 (phone) or 36 (desktop) button; its extra height is pulled back so the visible 20 holds | **adopted (MMR-743)** |
| Group heading and its explanation (Lifecycle's paragraph) | 12, line box to line box: the paragraph belongs to the heading more tightly than a field does | **adopted (MMR-743)** |
| Help line and the button it explains (Archive) | 16 | **adopted (MMR-743)** |

Help is not bound by a narrow control: it starts 8 below the control and
wraps at the 440 help measure, not the control's edge.

A form picks its Choice as ADR 0019's MMR-736 refinement does: a few one-word
options that fit on one row are a Segmented Control, options whose labels run
past a word are a Radio, and a longer fixed list is a Select. One recorded
exception: Launch in T3's Workspace stays a Segmented Control, as in the source
mock, though "Project checkout" and "New worktree" run past a word; its two
options fit one row at every width. A second: a T3 model option's values come
from the provider, unknown in advance, so it takes a Segmented Control only when
every label is one short word (at most 8 characters for one or two choices, 6
for three, 4 for four, counting Unset) and a Select otherwise, never a Radio.
A form should not need a stacked choice
list; where a Radio stacks, it follows these numbers:

| Stacked choice list | Phone | Desktop |
| --- | --- | --- |
| Label to the first row's text | 8 visible | 8 visible |
| Row height | 44 | 36 |
| Text to text between rows | 22 (44 − 22) | 14 (36 − 22) |

On desktop the row-to-row text gap (14) is larger than the label gap (8), so
the label still binds to the first row. On a phone the 44 tap row forces 22;
there, prefer a Select.

### Sheets, panels, dialogs

| Where | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Side padding of a Form sheet or a Content sheet: header, body, footer | 20 | 32 | **adopted (MMR-743)** in `FormSheet` and `ContentSheet`: Drawer is `p-4` (16) at every width. An Action menu's sheet keeps its own rule: 44 rows across its width, ending in a Cancel row |
| Header | 20 top and bottom after `env(safe-area-inset-top)`: 68 tall with a title alone, 92 with a context line. The close's 44 hit area centers on the title line | 28 top, 20 bottom; the close's 36 hit area centers on the title line | **adopted (MMR-743)** |
| Body | 24 top, 32 bottom | 32 top, 40 bottom | **adopted (MMR-743)** |
| Footer | 12 top, 12 + `env(safe-area-inset-bottom)` bottom | 16 top and bottom | **adopted (MMR-743)** |
| Footer note | one line, 13/20 `ink-dim`, directly above the full-width commit inside the bottom bar, 8 above it | left of the footer, vertically centred on Cancel and the commit, at least 16 clear of Cancel | **adopted (MMR-743)**: today in the body; the source keeps it in the footer row |
| Title and context line | 4 | 4 | **adopted (MMR-743)** |
| Buttons in a row | 12 | 12 | **adopted (MMR-743)**: `DialogFooter` is `gap-2` (8) |
| Dialog (a question) | 20 all round, 16 between blocks | 24 all round, 16 between blocks | **proposed**: today `p-4 gap-3` |

Header and footer are separated from the body by a `line` hairline, and both
stay put while the body scrolls. Nothing below a form's commit row scrolls.

The preview panel keeps these sides and the body's padding, but has its own
header, footer, edges, and phone height: see Feed blocks, Preview panel.

- **A footer note says what the commit leads to,** so it lives with the
  commit, not under the last field. It is the commit's `aria-describedby`.
- **When content is scrolled above the fold,** the pinned header gains a
  hairline shadow (`0 1px 0` plus a 4px soft drop: black 35% and 45% in
  dark, `#17242f` at 6% and 10% in light) that disappears at the top.
- **A resting scroll keeps a field gap at both bars.** At any resting
  position after the body has scrolled (the end of a scroll, a restored
  scroll, a still), the first visible label sits at least 24 below the
  header hairline at every width, which is the field gap, and nothing above
  that label shows: no control without its label, no sliver of a field. The
  body's own top padding (24 on a phone, 32 on desktop) applies only before
  it scrolls. The last visible block clears the footer hairline by at least
  the body's bottom padding (32 on a phone, 40 on desktop), measured from a
  choice row's whole tap row (44 or 36), not its text. Neither bar ever cuts
  a field, a group heading, or a choice row. A rest measures a checkbox row
  or a collapsible heading by its text, not its pulled-back tap row, and when
  the field gap would leave a sliver of the block above showing (a group
  heading sits 20 above its first label), the rest hides that block whole and
  the label sits 20 below the header.
- **Focus moves to a rest.** When a control takes focus out of view, the
  body scrolls to the nearest rest that shows its field whole, the control
  clear of the footer by the body's bottom padding; when no rest holds it, it
  scrolls the least that shows the control whole. A focused control is never
  under a bar (WCAG 2.4.11). The body does not use scroll snap: a mandatory
  snap re-rested a focused field under the header in Chromium, so a scroll
  the operator leaves mid-way stays where it is.
- **When whole fields cannot fit between the bars, add bottom scroll room;
  never cut a field.** If the natural end of the scroll would leave a field
  part-hidden under the header, the body grows its bottom padding until the
  end lands on a clean rest. Because the resting clearance equals the field
  gap, the end can rest between any two fields at every width, so the added
  room stays small. When content that is not a field follows the last block
  (Lifecycle's explanation and Archive), the end may also rest where that
  block is hidden whole. Example: Launch in T3 with Advanced open rests with
  Reasoning effort 24 below the header. A 32 desktop clearance was tried in
  MMR-743's mocks: the end could rest only where a group started, which left
  a stranded group hairline and about 300 of empty room.
- **Initial focus goes to the first field,** not to a later control. A form
  whose first field is a Choice already set (a seed's Kind) opens on the
  field the operator fills next.

### Toast (the Notice)

| Where | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Place | top, 8 below the app bar's bottom hairline, 14 from the sides, the phone page's gutter, so its edges line up with the cards below it; it never covers the bar or sits on its hairline. While a Walkthrough covers the console, 8 below the layer's header instead | bottom left on the content column's 20 gutter: 20 from the content area's left edge (past the sidebar when it shows) and 20 above the content area's bottom edge, past the version footer's strip, 356 wide | **adopted (MMR-743)**: `NoticeHost` places it from the bar and footer heights the shell measures, `--top-bar-height` and `--version-footer-height`; an open Walkthrough sets `--layer-top-bar-height` from its header (MMR-744) |
| Surface | `well-850`, 8 radius, and an edge brighter than a card's `line`: in dark a 1px `ink-ghost` edge (about 2.5:1), since tone and edge alone carry it; in light a 1px `line-bright` edge with the menu's drop (`0 8px 24px`, `#17242f` at 12%) plus a 2px contact shadow (`0 2px 6px`, at 10%). The overlay ramp's 48px drop washed out the card under it, so the light shadow is the menu's | same | **adopted (MMR-743)**: today `well-900` (the page's own fill) with `shadow-2xl` |
| Padding | 4 around the action, 16 before the text | same | **adopted (MMR-743)** |
| Text | 14 / 20 ink; the record's name ink-bright 600 | same | **adopted (MMR-743)** |
| Action | `accent-foreground` 600 text button, named for its effect ("Undo"); a Dismiss (×) follows it, so a keyboard can clear the Notice | same | ADR 0019 |

A Toast floats; it is never mistaken for a card in the list below it. It
takes a menu's surface but a deeper shadow than a menu, with a `line-bright`
edge where a card has `line`, so it reads above the page without a scrim.
The page it appears on is the page the console lands on: after Archive, the
next project's page, where the archived project's name appears only in the
Toast.

**Content under a Notice.** A Notice floats over whatever is beneath it, and
the page does not move or pad for it. On a phone it covers the top of the
first card for its few seconds; the card is still there when the Notice
times out, is dismissed (×), or is swiped away, and a list never jumps to
make room and jumps back. A route's banner under the top bar, such as
Offline, is covered the same way: the banner is a standing state that is
still showing when the Notice goes, while the Notice is the outcome of an
ask that just closed, so the newer message takes the place for its moment.
A Notice that needs to stay longer than a banner would be a banner itself.

### Pages

| Where | Value | Mark |
| --- | --- | --- |
| Page gutter | 20 (`p-5`); 14 on a phone where cards run edge to edge (`max-md:px-3.5`) | existing (`record-layout.tsx`, `focus-queue.tsx`) |
| Between page sections | 24–40 | existing range (`/kit` uses 40) |
| Between feed sections | 32 | **adopted (MMR-719)** |

### Feed blocks

The blocks every feed is built from (ADR 0019's MMR-719 refinement), in
`src/components/patterns/feed`. All values hold at every width unless a
column says otherwise.

| Block | Part | Value | Mark |
| --- | --- | --- | --- |
| Section head | Row | 44 tall on a phone, 36 on desktop, with or without See all; 12 to the content below | **adopted (MMR-719)** |
| | Name and count | `text-section` ink-bright, then the count 13 / 20 ink-dim, 8 apart, both inside the `h2` | **adopted (MMR-719)** |
| | See all | 13 / 20, 500, `accent-foreground`, underlined on hover (hover keeps the ink: `accent` measures 3.1:1 on a light page), right-aligned; a 44 hit area on a phone; its accessible name names the section ("See all in Now") | **adopted (MMR-719)** |
| Card | Surface | `well-850`, 1px `line` edge (`line-bright` on hover), 10 radius, `shadow-card` in light; padding 12 top, 16 sides, 16 bottom | **adopted (MMR-719)**; surface existing (`Card`) |
| | Status line | 13 / 20 ink-dim: the status badge, or for a set of decisions the word _Decisions_ after an attention dot, then the ID in 13px mono, 8 apart; the age right-aligned on line 1; 8 below it to the title | **adopted (MMR-719)** |
| | Title | `text-title`, wraps; a long word breaks rather than overflow | existing role (MMR-718) |
| | Detail | 13 / 20 ink-dim, 4 below the title, two lines at most | **adopted (MMR-719)** |
| | Chip row | the row chips (size, grooming, stale), 4 apart, wrapping; 8 below the title or detail, staying with the content they describe | **adopted (MMR-719)** |
| | Button | one at most; at least 44 tall on a phone and 36 on desktop, which the card holds whatever the caller's button sets; at least 12 below the content above it, held to the card's bottom so buttons line up across a grid row | **adopted (MMR-719)** |
| | Between cards | 8 in a stack; 12 in a desktop grid, where the cards of a row share its height, so a card without a button keeps room at its foot | **adopted (MMR-719)** |
| Card grid | Columns | a stack below `md`. From `md` up, two columns only when the grid itself is at least 612 wide (two cards of 300 and the 12 gap), a container query on the grid, not the viewport's `md` alone. With the column's 20 gutters that is 652 of room. A closed feed is two columns at every desktop width (768 with no sidebar column and 1024 beside the 256 sidebar both leave a 728 grid); an open one is one column from 768 to 1091 and two from 1092 (see Preview panel) | **adopted (MMR-720)**: `CardGrid` turned two columns at `md` (`md:grid-cols-2`), whatever the room |
| Row group | Row | a link, at least 44 tall on a phone and 36 on desktop, a `line` hairline between rows; its text at the section head's left edge, its hover fill 4 past it | **adopted (MMR-719)** |
| | Key | `text-mono-id` ink-dim, in a column at least 48 wide | **adopted (MMR-719)** |
| | Name | `text-title` in ink, a step under a card title's ink-bright, so a door does not read as a work item; two lines at most | **adopted (MMR-719)** |
| | Count and chevron | 13 / 20 ink-dim, right-aligned; the chevron ink-dim, decoration | **adopted (MMR-719)** |
| | The capped group's last row | the same row shape, its name in `accent-foreground` ("5 more projects"), underlined on hover, a link to the list with a filter set | **adopted (MMR-719)** |
| Day fold | Trigger | a row 44 tall on a phone and 36 on desktop, its chevron at the section head's left edge: the Collapsible primitive's 16 chevron (right when closed, down when open), the day label, the count; it opens at once, with none of the Collapsible primitive's height animation or chevron turn (ADR 0019 §8) | **adopted (MMR-719)** |
| | Finished row | a link, at least 44 tall on a phone and 36 on desktop: the status dot centred in a 16 column (as the chevron above it), the title `text-title` in ink-dim on one line, 8 after it so it lines up with the day label, the time 13 mono ink-dim at the right | **adopted (MMR-719)** |
| | Abandoned row | adds a second line, 13 / 20: the status word (ink-bright, 600, as every status word), then the reason in ink-dim | **adopted (MMR-719)** |
| | Show N more | a text button 44 tall on a phone and 36 on desktop, 14 / 20, 500, `accent-foreground`, underlined on hover; indented 28 to line up with the row titles | **adopted (MMR-719)** |
| Shipped summary | Chart | a 1px `ink-faint` baseline under the plot, a separator that carries the zero line (the breakdown's divider stays `line`), so a zero day reads as zero; seven columns, 8 apart, each a 16 count row, an 84 plot, and a 32 two-line label row, its track pinned to the column's share so a wide label overhangs rather than widen it; bars at most 44 wide, 3 top radius, in `status-done`; any day above zero at least 4 tall, so a smaller day never draws taller; the columns share the card's width | **adopted (MMR-719)** |
| | Labels | counts and day names 12 / 16 ink-dim; today's in ink-bright, 600, with "so far" under its name | **adopted (MMR-719)** |
| | Today's bar | a solid fill mixed 45% `status-done` into `well-850` (a mixed color, not opacity), with a 1px `status-done` edge, which the 4 floor keeps around a fill | **adopted (MMR-719)** |
| | Counts over 999 | shortened on screen to four characters (1.2k, 12k, 1.2M, 1B, 1T; a value that would round to 1000 of a unit moves up), so a label stays within its column and the gaps beside it (36 at 320), and neighbours never touch; exact in the chart's accessible name | **adopted (MMR-719)** |
| Quiet line, quiet sentence | Text | `text-body` (14 / 23) in ink, no frame, at the section head's left edge, 32 from the block above. A quiet line takes a section's place; it never sits under a section's own head | **adopted (MMR-719)** |

#### Preview panel

The card's preview (ADR 0019's MMR-720 refinement), in
`src/components/patterns/feed`. The preview panel shows as a bottom sheet
below 768, a modal Drawer over the scrim, and as a panel from the right from
768, a Drawer with `modal={false}` and no scrim. Its sides and body padding
follow Sheets, panels, dialogs; the rest is its own.

| Where | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Surface | a bottom sheet over the scrim, `well-850`, 12 top corners; its top edge a 1px `sheet-seam`; `shadow-2xl` in dark, and in light the upward shadow of a Select's bottom list (`0 -12px 32px`, `#17242f` at 14%) | a 440 panel from the right, from the top bar's measured bottom (`--top-bar-height`) to the viewport's bottom, with no scrim; `well-850`; its left edge 1px `ink-ghost` in dark and `line-bright` in light; `shadow-2xl` in dark, and in light `shadow-panel` (`-4px 0 12px`, `#17242f` at 12%), cast left and short so it ends clear of the selected card 20 beside the panel: that card's `accent` edge keeps 3.06:1 against the ground, where `shadow-overlay`'s 48 blur darkened it to 2.99:1 (Chromium, 1280) | **adopted (MMR-720)** |
| Height | fits its content, up to 88% of the visible viewport; the grip, header, and footer stay put and only the body scrolls | the panel's full height below the bar; the header and footer stay put and only the body scrolls | **adopted (MMR-720)** |
| Grip | 40 × 4, full radius, `ink-faint` (decoration), 8 below the sheet's top edge | none | **adopted (MMR-720)**: `DrawerGrip` sits 12 below the edge |
| Header | 12 top (below the grip), 16 bottom, 20 left, 56 right to clear Close; a `line` hairline under it | 28 top, 20 bottom, 32 left, 64 right; a `line` hairline under it | **adopted (MMR-720)** |
| Status line | the card's own status line (13 / 20 `ink-dim`: the status badge (or _Decisions_ after its dot), the ID in 13 mono, the age at the right), 8 above the title | same | **adopted (MMR-720)** |
| Title | `text-dossier`, 17 / 24, 600, `ink-bright`; it wraps, a long word breaks, and it is never clamped. It takes focus on open and switch (`tabindex="-1"`); on `:focus-visible` only, the 2px `accent` outline at 2px offset that a button takes, with a 4 radius | same | **adopted (MMR-720)**: a Content sheet's title is 14px |
| Close | a 44 hit area, 20 glyph, `ink-dim`, centred on the status line, 8 from the right edge; named "Close preview" | a 36 hit area, 18 glyph, centred on the status line, 22 from the right edge | **adopted (MMR-720)** |
| Body | 24 top, 32 bottom, 20 sides | 32 top, 40 bottom, 32 sides | **adopted (MMR-720)**, the Form sheet's |
| Reason | 16 / 25, 400, `ink-bright`, `text-wrap: pretty`, complete sentences; a task's opening sentence, which names its state ("Needs an answer before it can start."), sets in 600 | same | **adopted (MMR-720)** |
| Text after the reason | `text-body` (14 / 23) `ink`, 12 below the reason, `text-wrap: pretty`; cut at the end of a sentence, never mid-sentence | same | **adopted (MMR-720)** |
| Fact list | a definition list 20 below the text above it, then a `line` hairline and 20 to the first fact; a 104 label column and the value column, 16 apart; 14 between facts. Label 13 / 20 `ink-dim`, set 1 down so its baseline meets the value's first line; value 14 / 22 `ink-bright`, a long word breaks | same | **adopted (MMR-720)** |
| Relation (a parent, a dependency, a bundle's task) | plain text, not a link: the ID in mono `ink-dim` at the line's size with `--mono-adjust`, 6 before its title; one relation a line, 4 apart | same | **adopted (MMR-720)** |
| Footer | a `line` hairline above; 12 top, 12 + `env(safe-area-inset-bottom)` bottom, 20 sides. Two equal tracks 12 apart, Open then the action; each button at least 44 tall with 10 / 12 padding, its label centred and wrapping inside the button, both buttons the row's height. Open alone fills the row | 16 top and bottom, 32 sides; right-aligned, content width, 12 apart, Open then the action; 44 tall, 20 side padding | **adopted (MMR-720)** |
| Open | an outline button (1px `ink-faint` inset edge, `ink-bright` label), always; its accessible name adds the ID it leads to: the record's ("Open HUGI-15"), or for a delivery's bundle, whose header names no record, the delivery's ("Open MMR-706"); a project's bundle, with no ID to add, is "Open" | same | **adopted (MMR-720)** |
| The card's action | the panel's one solid `action` button, whatever variant the card draws it in | same | **adopted (MMR-720)** |
| The selected card | the card whose preview is open: its fill `accent` mixed 7% into `well-850` (a mixed color, not opacity), lighter than a selected segment's `accent/12` wash because it lies under a whole card's body text, which must keep 4.5:1 (the built-UI rating checks it); its 1px edge `accent` in place of `line`, the full-strength ring a selected segment takes; its outline button's edge steps from `ink-faint` to `ink-dim`, keeping 3:1 on the wash | same | **adopted (MMR-720)** |

Rules:

- **The desktop layout makes room in three ranges.** The sidebar sits
  beside the page from 1024 (`DESKTOP` in `routes/shell.tsx`) and is a
  drawer below it. The feed column is 900 at most, with 20 gutters from
  `md`.
  - **768 to 1023:** no sidebar column. The panel sits beside the feed, and
    the feed's columns follow the card grid's container rule.
  - **1024 to 1599:** the 256 sidebar slides out with the panel and back as
    it closes, and the column centres in the space left of the panel: 840 at
    1280.
  - **1600 and up:** the sidebar stays, and the column re-centres 220 to the
    left, half the panel's width, in step with the slide.

  The feed scrolls on its own, apart from the panel.
- **Columns follow the room** (Card grid, above). Beside the open panel the
  feed is two columns of 394 at 1280 and of 424 at 1680, and one column of
  544 at 1024 and of 288 at 768.
- **The selected card scrolls into view** after any reflow on open, switch, or
  close.
- **Focus.** Open and switch move focus to the title. On desktop nothing
  traps it: Close follows the title in tab order, so Shift+Tab from the title reaches the selected card, and Tab from
  the last footer button reaches the control after the selected card's stretched target (its own button, else the next card). The panel holds that place both ways: Tab from the card's target reaches the title, Shift+Tab from the control after it reaches the last footer button, and Tab from anywhere else passes the panel by, so focus never loops back into it and Tab past the page's end leaves the document. Escape closes the topmost layer first (a menu, the jump palette, or the sidebar drawer), then the panel. On a phone the bottom
  sheet is modal and holds focus until it closes. Closing returns focus to
  the card that opened the latest preview, and a switch makes the newly
  clicked card that opener. `useFinalFocus` (`patterns/opener.ts`) captures
  the opener only when `open` turns true, and a switch keeps `open` true, so
  the pattern sets the opener itself on a switch.
- **A switch changes the content in place at once** and resets the body's
  scroll to the top; a cross-fade would be a fourth mover (ADR 0019 §8).
  Under `prefers-reduced-motion` there is no slide; the panel, the sidebar,
  and the column change at once.
- **A capped sheet rests on a whole fact.** When the body runs past the 88%
  cap, it scrolls under the pinned bars by the resting rules of Sheets,
  panels, dialogs (`patterns/feed/preview-rests.ts`). Neither bar cuts a
  block at a rest: the fact at the footer is whole or hidden under it, and the
  block at the header sits below it with the block above hidden whole. The
  reason and the text after it rest as one block, since 12 apart neither
  could keep the field gap. A rest hides the fact list's hairline whole and
  puts the first fact 20 below the header, or as little as 14 where the footer
  would otherwise cut the fact it meets, and a later fact 14, the list's own
  row gap. Where no rest clears both bars within a body's height of the
  last, so a block would never show whole, the rest keeps the header clean and
  the footer may cut. A fact taller than the body (a bundle's long Tasks)
  rests at its top and where its bottom meets the footer, and scrolls freely
  from its top onward, wherever the footer cuts no other block, so every
  relation in it can be read. A swipe or scroll that stops between rests
  glides on to the next rest the way it moved (at once under reduced motion),
  so the sheet never rests on a clipped sentence. Once the body has scrolled, the header
  gains the pinned header's scroll shadow. While the body continues under the
  footer, the footer shows the overflow cue: its hairline steps from `line` to
  `ink-ghost` in dark and to `line-bright` in light, and its top edge gains
  the same shadow, and all go when the body reaches its end. The hairline
  carries the cue in dark, where the shadow does not show on `well-850` and
  `line-bright` is about 1.4:1; `ink-ghost` measures 2.5:1 against the
  footer's `well-850` (Chromium, 390).
- **Swipe-down closes the sheet only from the body's top.** With the body
  scrolled, the gesture scrolls the body back up. A tap on the scrim closes
  the sheet.
- **The seam clears 3:1 against the scrim.** `sheet-seam` is one named token
  for the top edge of a phone bottom sheet. It clears 3:1 against the
  rendered scrim (the scrim over the feed) in both themes, at several
  feed scroll positions, over the page and over a card, and its value is
  chosen by measurement in the build. `ink-faint` does not: it measures about
  2.7–2.8:1 against the light scrim. A Select's bottom list uses the same
  token. Measured in Chromium at 390 (MMR-720), the seam's pixels against the
  scrim's pixels just above it, at 12 points across the sheet's width, for four
  cards at five feed scroll positions: `ink-dim` in dark holds 3.92:1 at worst (a second measurement; the first read 3.98:1),
  where the scrim lies over a solid action, and `ink` in light 4.38:1. The
  candidates that failed: `ink-faint` in dark fell to 1.95:1 over that action,
  and the `ink-faint`/`ink-dim` mix in light (`#7a8b98`, about 3.2:1 against the
  flat scrim) measured 2.06–2.75:1, since the sheet's upward shadow darkens the
  scrim at the seam.

## Sizes

| Control | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Input, Select trigger, Combobox | 44 tall | 44 tall | existing for Input (`h-11`); **adopted (MMR-743)** for Select (`min-h-9`, 36) so a form's controls share one height |
| Segmented track | 50: a 3px inset (the 1px edge, then 2 clear) leaves each segment a 44 tap target; segments share the width | 44, segments 38, full field width, segments share it, so every control in a form ends on one right edge | **adopted (MMR-743)**: today about 28 |
| Textarea | 3 lines: 88 (22 × 3 + 22 padding); grows by line | same | existing line height; height **adopted (MMR-743)** |
| Textarea `grow` (Composer, Walkthrough note) | 1 line: 44; grows to 4 lines, 110 (22 × 4 + 22), then scrolls. Both are border-box heights: the 22 is 20 of padding and the 1px top and bottom borders, so `clientHeight` reads 108 at the cap | same | **adopted (MMR-744)**: `max-h-[110px]` |
| Segmented segment text | 14 / 20, 500, `text-label`, sentence case (a provider's values keep their own case) | same | **adopted (MMR-743)**: today the 10.5px uppercase microlabel |
| Choice row (radio, checkbox, switch) | 44 min | 36 min | 44 existing for Switch rows (ADR 0019 MMR-712); 36 **adopted (MMR-743)** |
| Radio and checkbox box | 16 | 16 | existing (`size-4`) |
| Switch | 40 × 24 | 40 × 24 | existing |
| Footer button | 44, full width for the commit | 44, content width, 20 side padding, the height of the controls above it | **adopted (MMR-743)**: ActionButton `sm` renders about 28 tall in 12px |
| Commit while the form cannot be sent | `disabled` until the required fields hold a value. Drawn as the quiet disabled button under Color roles, never faded | same | `disabled` condition existing; the look **adopted (MMR-743)** (today `disabled:opacity-40`) |
| Close and icon buttons | 44 hit area, 20 glyph | 36 hit area, 18 glyph | **adopted (MMR-743)** |
| Menu row in a Sheet | 44 | 36 | 44 existing (ADR 0019 MMR-736); 36 **adopted (MMR-743)** for 15px rows (Select item is `min-h-8`, 32, in 13px) |
| Toast action (Undo) | 44 tall, 64 wide at least | 36 | **adopted (MMR-743)** |

Every tap target on a phone is at least 44 × 44, including a link inside help
text's row and the close glyph.

## Radii, borders, hairlines

| Thing | Value | Mark |
| --- | --- | --- |
| Input, Textarea, Select trigger, segment | 6 (`rounded-md`) | existing |
| Button, Segmented track, Dialog | 8 (`rounded-lg`) | existing |
| Bottom sheet top corners (content size) | 12 (`rounded-t-xl`) | existing; a form sheet on a phone is full screen and square |
| Switch, grip, pill | full | existing |
| Card | 10 | existing (`Card`) |
| Chart bar, top corners | 3 | **adopted (MMR-719)** |
| Structure line (section rule, header and footer edges, panel edge; the preview panel's desktop edge is its own, under Feed blocks) | 1px `line` | existing |
| Control edge | 1px `ink-faint`, `ink-dim` on hover, `status-blocked` when invalid, `accent` on focus | **adopted (MMR-743)** `ink-faint` (today `line-bright`, 1.4:1); invalid existing (`TEXT_FIELD_CLASS`) |
| Focus on a field (Input, Textarea, Select trigger, Combobox) | the edge itself turns `accent` and a 1px `accent` outline at offset 0 joins it: one 2px ring at the control's edge, never a frame inside a frame. 8.7:1 dark, 3.7:1 light on `well-850` | existing border turn (`focus-visible:border-accent`); the joined outline **adopted (MMR-743)** |
| Focus on a segment | 2px `accent` outline at offset −2, inset inside the segment; while focused it replaces the selection ring (the wash stays). 7.7:1 dark, 3.0:1 light on the wash | **adopted (MMR-743)**: today the button ring, 2px out, which collides with the track |
| Focus on a button, checkbox, or the close | 2px `accent` outline, 2px offset | existing (`actionButtonVariants`) |
| A menu over a sheet | `well-800`, 1px `ink-faint` edge, `shadow-menu` in light, 8 radius, 4 inset | **adopted (MMR-743)**: `SelectContent` is `well-850` with `line-bright`, which vanishes over a `well-850` sheet |
| A Select's menu, desktop | opens 8 below the trigger, which clears the trigger's 1px focus ring by 7; at least the trigger's width. It either covers every block below it whole (a field, a hairline, a heading) or ends at least 12 above the next one; if neither fits, it flips above or caps its height and scrolls. Groups are set off by their heading (12 above it after the first group), not by a rule | **adopted (MMR-743)** |
| A Select's menu, phone | a bottom list: a content-sized bottom sheet over the overlay scrim (70% `well-950` with its 2px blur), `well-850`, 12 top corners, a decorative `ink-faint` grip, the field's label as a 16/600 heading, 44 rows with text at the 20 gutter, a tick on the chosen row and no highlight on it when a tap opens the list (the highlight is the keyboard's), and the home-indicator inset below the last row. Its top edge is a 1px `sheet-seam` seam, 3:1 or better against the rendered scrim in both themes, the token the preview panel's bottom sheet uses (`ink-faint` measures about 2.7–2.8:1 against the light scrim, and a `line-bright` seam 1.4:1); in light it also casts a shadow upward (`0 -12px 32px`, `#17242f` at 14%) so the sheet separates from a light scrim. Its height is at most `100dvh - env(safe-area-inset-top) - 64`, so the scrim stays visible and tappable above it; a longer list scrolls inside, under its pinned grip and heading, with the home-indicator inset kept below the last row | **adopted (MMR-743)**: a popover on a phone lands over the next fields and cuts them; the seam token **adopted (MMR-720)**, as the `ink-faint` seam it replaces is under 3:1 in light |

Hairlines divide groups; they never box a single field. A group is never a
card inside a sheet.

## Layout widths

| Surface | Width | Mark |
| --- | --- | --- |
| Dialog | `min(92vw, 380px)`; `wide` `min(92vw, 560px)`; `full` the whole viewport | existing (`dialog.tsx`) |
| Sheet, content | bottom sheet below 768; 440 right panel from 768 | existing (`drawer.tsx`) |
| Sheet, form | full screen below 768; 640 right panel from 768, so 576 of field width | existing (`drawer.tsx`) |
| Breakpoint where a sheet becomes a panel | 768 (`md`) | existing (`DRAWER_DESKTOP_QUERY`) |
| Content column | 1200 max for record and work pages; 720–960 for single-purpose pages | existing (`record-layout.tsx`, `focus-queue.tsx`, `settings-page.tsx`) |
| Prose measure | about 70ch, a target rather than a hard limit; 440px for all prose in a form | existing practice (walkthrough uses 62ch); the form measure **adopted (MMR-743)** |

## The Form sheet, assembled

```
phone, full screen                      desktop, 640 panel
┌──────────────────────────────┐        ┌──────────────────────────────────────┐
│ safe area                    │        │                                      │
│ Title                    [×] │ 20/20  │ Title                            [×] │ 28 / 20
│ context line (edit only)     │        │ context line (edit only)             │
├──────────────────────────────┤ line   ├──────────────────────────────────────┤
│ 24                           │        │ 32                                   │
│ Label                        │        │ Label                                │
│ 8                            │        │ 8                                    │
│ [ control             44 ]   │        │ [ control                       44 ] │
│ 8                            │        │ 8                                    │
│ help, 13px ink-dim           │        │ help                                 │
│ 24                           │        │ 24                                   │
│ next field …                 │        │ next field …                         │
│ 32 ─── line ─── 24           │        │ 32 ─── line ─── 24                   │
│ Group heading 16/600         │        │ Group heading                        │
│ 20 …                         │        │ 20 …                                 │
│ 32                           │        │ 40                                   │
├──────────────────────────────┤ line   ├──────────────────────────────────────┤
│ footer note, if any          │ 12     │ footer note       [Cancel] [Commit]  │ 16, 44 tall
│ 8                            │        │                                      │
│ [        Commit         44 ] │        │                                      │
└──────────────────────────────┘        └──────────────────────────────────────┘
 20 sides                                 32 sides
```

- The header holds the title, and a context line only when the form acts on
  an existing record.
- On a phone the close is in the top bar and the commit is full width in the
  bottom bar; there is no Cancel. On desktop the footer is Cancel then the
  commit, right-aligned, in that DOM order.
- **Phone tab order.** With no Cancel on a phone, the last control of the body
  sits next to the commit in tab order: in Project settings, Tab from Archive
  project lands on Save, and Shift+Tab from Save lands on Archive. Archive
  runs at once, so a slip of one key archives; its Notice's Undo softens that,
  and Archive is held while a Save runs.
- A destructive or lifecycle group (Archive) is the last group of the
  scrolling body, in DOM order. No CSS `order` rearranges a form.
- Rarely used settings sit in a collapsed group (Advanced) at the end of the
  body, so the common form fits above the commit at 390 × 844 and 1280 × 800.
  A field that only matters for one choice (Branch, for New worktree) appears
  only when that choice is made.
- A Select shows the value alone ("Sonnet 5.5"). When options come in groups,
  the group's name is a heading inside the open menu, not a prefix on the
  value. An unchosen Select reads as its empty option ("Choose a project…"),
  and the commit waits for it.
- A footer note sits in the footer: on desktop left of Cancel and the commit,
  level with them; on a phone one line above the full-width commit.

### Examples

The forms built on these numbers (MMR-743), for checking a build against them:

- **File a seed.** Kind (a Segmented Control: Idea, Bug, Feature), Seed (a
  Textarea whose help reads "First line is the title. Shift+Enter for a body
  line."), and Project (a Record picker reading "`MMR` — Mimir"). It opens on
  Seed, after Kind, which already holds Idea. File seed waits for text and a
  project; Enter in Seed files.
- **New project.** Title, Key, and Description (optional, no help and no
  placeholder). Key is 128 wide; its help, "Suggested from the title. It
  can't change later: it names every ID (`KEY-1`, `KEY-2`, …).", starts 8
  below it, wraps at 440, and quotes the real key once one exists. The footer
  note is "Joins the project list on the review page." Create project waits
  for a title and a key.
- **Project settings.** The same form without Key; the context line reads
  "Project key `MMR`". Save stays enabled while the title is set. Lifecycle
  is the last group: its explanation, then Archive project 16 below it.
- **Launch in T3.** System (`asgard`, mono), Project ("Mimir", the title),
  Model ("Sonnet 5.5"; an identifier such as `gpt-6.1-sol` in mono), each model
  option (Reasoning effort as `low`, `medium`, `high`), and Runtime, then
  Advanced, folded: Workspace, Branch (optional, only for New worktree), and
  Plan first. The context line is "`MMR-743` Form sheet pattern". It opens on
  System. With Advanced open on a phone, the end of the scroll rests with
  Reasoning effort 24 below the header, adding about 50 of bottom room.
