# Console design guidelines

The measurable rules for building and reviewing console UI. [ADR 0019](../../docs/decisions/0019-meridian-console-design-system.md)
holds Meridian's semantic rules (what each hue means, the motion budget, the
pattern set); this file holds the numbers. Tokens live in
[`src/styles.css`](src/styles.css); primitives in [`src/components/ui`](src/components/ui).

Every value is marked:

- **existing**: in the code today; the source is cited.
- **adopted (MMR-743)**: proposed with the Form sheet's mock, approved with
  it, and now carried by the primitives and patterns. The reason given beside
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
| Row or card title in a feed | 16 / 22 | 500 | ink-bright | `text-title` | **adopted (MMR-718)**: rows were `text-body` (14, regular) and phone cards `text-card-mobile` (15); a title must lead its meta |
| Group heading inside a form (Advanced, Lifecycle) | 16 / 24 | 600 | ink-bright | `text-base` | **adopted (MMR-743)**: groups today use the 10.5px microlabel, under the floor |
| Control text (input value, option label, select value) | 15 / 22 | 400 | ink-bright | `text-[15px] leading-[22px]` (Input, Textarea) | existing |
| Field label | 14 / 20 | 500 | ink | `text-label` | **adopted (MMR-743)**: `FIELD_LABEL_CLASS` is 12px ink-dim; a label must read before its control |
| Body, prose | 14 / 23 (1.65) | 400 | ink | `text-body` | existing |
| Button label | 14 / 20 | 600 | per variant | `text-label` | size and weight existing (ActionButton `default`); the token **adopted (MMR-743)** |
| Help, context line, meta, a footer note, a group's explanation (Lifecycle) | 13 / 20, measure 440, `text-wrap: pretty` | 400 | ink-dim | `text-meta` | **adopted (MMR-743)** for help: `FieldDescription` is 12px ink-faint (2.6:1 on light) |
| Group heading inside a menu (a provider over its models) | 13 / 20 | 500 | ink-dim | `text-meta` | **adopted (MMR-743)** |
| Status word | 13 / 20 | 600 | ink-bright; the hue only on its dot | `text-meta` | **adopted (MMR-718)**: the word drew in its status hue on a 12% wash, uppercase at 10.5 on headers |
| Record ID alone in a row's ID column | 12.5 / 18, mono | 400 | ink-dim | `text-mono-id` | **adopted (MMR-718)**: was 11.5 in ink-faint; an ID that shares a line with sans text (a meta line, a header's status line) takes the line's 13 |
| Microlabel (the one all-caps idiom) | 12 / 16, tracking 0.1em, uppercase | 600 | ink-dim or brighter | `.microlabel` (`text-micro`) | **adopted (MMR-718)**: was 10.5, tracked 0.13em, often ink-faint |
| Floor: tags, captions | 12 / 16 | 400–600 | ink-dim or brighter | `text-xs`, `text-tag` | **adopted (MMR-718)**: `text-tag` (11) and `text-micro` (10.5) rose to 12 |

`text-body` is one size with one line height: 14 / 23, for prose. A label is
not prose, so it gets its own token: `--text-label` (14px) with a paired 20px
line height, for a field label, a button label, and a segment's text
(**adopted (MMR-743)**, `styles.css`); `text-body` keeps 14 / 23 for body copy.

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
  mono, not a smaller step.
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
| Faint | `ink-faint` | 3.2 / 3.4 / 3.5 | 3.1 / 2.6 / 2.9 | non-text only: a control's edge, an off switch, a grip, disabled glyphs |
| Ghost | `ink-ghost` | 2.5 / 2.6 / 2.7 | 2.3 / 2.0 / 2.2 | decoration only, never placeholder ink (2.7:1 dark, 2.2:1 light on `well-950`); see the placeholder rule below. **Adopted (MMR-743)** in the text field and the search boxes of the Record picker and the jump palette; and, with MMR-744, the Composer and the Walkthrough's text boxes; the authoring sheet's and pairing's `ink-ghost` placeholders moved to `ink-dim` with MMR-718 |
| Accent | `accent`, `accent-foreground` | 8.7, 10.5 on 850 | 3.7, 6.8 on 850 | focus, selection washes and rings, links (`-foreground` as text) |
| Action | `action` / `action-foreground` | 8.0:1 | 9.5:1 | the one solid button per surface |
| Danger | `status-blocked-foreground` | 8.7 on 850 | 6.3 on 850 | error text, the destructive outline's label |

All existing (`styles.css`). Rules:

- **Text that carries information is `ink-dim` or brighter**: 4.5:1 or better
  on every well in both themes. `ink-faint` and `ink-ghost` never carry it
  (MMR-718).
- **A status word is `ink-bright`; only its dot carries the hue** (ADR 0019,
  MMR-718). The word is 13/20 semibold, sentence case, with no wash or ring,
  so the grey statuses read as well as the bright ones (`abandoned` as text
  measured 1.8:1 on a dark card). On a record header the status leads the
  line, then a `line` hairline, then the type and ID in `ink-dim`.
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
| Structure line (section rule, header and footer edges, panel edge) | 1px `line` | existing |
| Control edge | 1px `ink-faint`, `ink-dim` on hover, `status-blocked` when invalid, `accent` on focus | **adopted (MMR-743)** `ink-faint` (today `line-bright`, 1.4:1); invalid existing (`TEXT_FIELD_CLASS`) |
| Focus on a field (Input, Textarea, Select trigger, Combobox) | the edge itself turns `accent` and a 1px `accent` outline at offset 0 joins it: one 2px ring at the control's edge, never a frame inside a frame. 8.7:1 dark, 3.7:1 light on `well-850` | existing border turn (`focus-visible:border-accent`); the joined outline **adopted (MMR-743)** |
| Focus on a segment | 2px `accent` outline at offset −2, inset inside the segment; while focused it replaces the selection ring (the wash stays). 7.7:1 dark, 3.0:1 light on the wash | **adopted (MMR-743)**: today the button ring, 2px out, which collides with the track |
| Focus on a button, checkbox, or the close | 2px `accent` outline, 2px offset | existing (`actionButtonVariants`) |
| A menu over a sheet | `well-800`, 1px `ink-faint` edge, `shadow-menu` in light, 8 radius, 4 inset | **adopted (MMR-743)**: `SelectContent` is `well-850` with `line-bright`, which vanishes over a `well-850` sheet |
| A Select's menu, desktop | opens 8 below the trigger, which clears the trigger's 1px focus ring by 7; at least the trigger's width. It either covers every block below it whole (a field, a hairline, a heading) or ends at least 12 above the next one; if neither fits, it flips above or caps its height and scrolls. Groups are set off by their heading (12 above it after the first group), not by a rule | **adopted (MMR-743)** |
| A Select's menu, phone | a bottom list: a content-sized bottom sheet over the overlay scrim (70% `well-950` with its 2px blur), `well-850`, 12 top corners, a decorative `ink-faint` grip, the field's label as a 16/600 heading, 44 rows with text at the 20 gutter, a tick on the chosen row and no highlight on it when a tap opens the list (the highlight is the keyboard's), and the home-indicator inset below the last row. Its top edge is a 1px `ink-faint` seam, 3:1 against the scrim in both themes (a `line-bright` seam measured 1.4:1 in light); in light it also casts a shadow upward (`0 -12px 32px`, `#17242f` at 14%) so the sheet separates from a light scrim. Its height is at most `100dvh - env(safe-area-inset-top) - 64`, so the scrim stays visible and tappable above it; a longer list scrolls inside, under its pinned grip and heading, with the home-indicator inset kept below the last row | **adopted (MMR-743)**: a popover on a phone lands over the next fields and cuts them |

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
