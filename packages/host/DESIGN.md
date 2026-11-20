# Console design guidelines

The measurable rules for building and reviewing console UI. [ADR 0019](../../docs/decisions/0019-meridian-console-design-system.md)
holds Meridian's semantic rules (what each hue means, the motion budget, the
pattern set); this file holds the numbers. Tokens live in
[`src/styles.css`](src/styles.css); primitives in [`src/components/ui`](src/components/ui).

Every value is marked:

- **existing**: in the code today; the source is cited.
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
| Sheet or Dialog title (a form) | 21 / 28, tracking -0.01em | 600 | ink-bright | `text-header` | **proposed**: today `OVERLAY_TITLE_CLASS` is 14px, which cannot anchor a 640px panel |
| Record title | 17 / 24 | 600 | ink-bright | `text-dossier` | existing |
| Group heading inside a form (Advanced, Lifecycle) | 16 / 24 | 600 | ink-bright | `text-base` | **proposed**: groups today use the 10.5px microlabel, under the floor |
| Control text (input value, option label, select value) | 15 / 22 | 400 | ink-bright | `text-[15px] leading-[22px]` (Input, Textarea) | existing |
| Field label | 14 / 20 | 500 | ink | `text-body` | **proposed**: `FIELD_LABEL_CLASS` is 12px ink-dim; a label must read before its control |
| Body, prose | 14 / 23 (1.65) | 400 | ink | `text-body` | existing |
| Button label | 14 / 20 | 600 | per variant | `text-body` (ActionButton `default`) | existing |
| Help, context line, meta, a footer note | 13 / 20 | 400 | ink-dim | `text-meta` | **proposed** for help: `FieldDescription` is 12px ink-faint (2.6:1 on light) |
| A group's explanation (Lifecycle) | 13 / 20, measure 368, `text-wrap: pretty` | 400 | ink-dim | `text-meta max-w-[368px] text-pretty` | **proposed**: today 12.5px; 368 keeps every line under 70 characters and, for the Lifecycle text, ends on a whole sentence at both widths (lines of 56, 64, 54, 40 on desktop; 56, 60, 58, 40 on a phone) |
| Group heading inside a menu (a provider over its models) | 13 / 20 | 500 | ink-dim | `text-meta` | **proposed** |
| Floor: tags, IDs, captions | 12 / 16 | 400–600 | ink-dim or brighter | `text-xs` | **proposed**: `text-mono-id` (11.5), `text-tag` (11), `text-micro` (10.5) rise to 12px, per MMR-718's "nothing under 12px" |

Rules:

- **Nothing that carries information is under 12px.** Decoration (a grip, a
  glyph) is exempt.
- **One step of difference at least** between neighboring roles: a label (14)
  never sits beside a help line (13) in the same ink and weight; the label
  is ink at 500, the help ink-dim at 400.
- **Sentence case everywhere.** The uppercase microlabel is the one all-caps
  idiom (ADR 0019 §6) and is for column and lane captions on dense feeds only,
  never in a form, never as a label.
- **Measure.** Prose wraps at 70 characters at most. Help text in a form is
  capped at 440px (about 70 characters at 13px) and set `text-wrap: pretty`;
  under a narrow control it still runs past the control's edge to that cap.
  A parenthetical list of examples stays on one line (`white-space: nowrap`
  from the word before it), so "every ID (`KEY-1`, `KEY-2`, …)" never
  splits.
- **No line of a paragraph is a single word.** Tune the measure until the
  last line holds a phrase, and check both widths.
- **Mono sizes match their neighbors.** An ID inside a 13px meta line is 13px
  mono, not a smaller step.
- **A context line names what a mono value is.** A bare key reads as stray:
  write "Project key `MMR`", or put the record's title after its ID
  ("`MMR-743` Form sheet pattern"). The mono value takes the line's ink
  (`color: inherit`), in help text too.
- **Identifiers are mono wherever they appear,** a Select's value included:
  a system (`asgard`), a project slug (`mimir`), a key. A value that pairs a
  key with a title keeps the source's format, the key in mono and the title
  in sans: "`MMR` — Mimir".
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
| Ghost | `ink-ghost` | 2.5 / 2.6 / 2.7 | 2.3 / 2.0 / 2.2 | decoration only. **Proposed**: no longer placeholder ink (2.7:1 dark, 2.2:1 light on `well-950`); see the placeholder rule below |
| Accent | `accent`, `accent-foreground` | 8.7, 10.5 on 850 | 3.7, 6.8 on 850 | focus, selection washes and rings, links (`-foreground` as text) |
| Action | `action` / `action-foreground` | 8.0:1 | 9.5:1 | the one solid button per surface |
| Danger | `status-blocked-foreground` | 8.7 on 850 | 6.3 on 850 | error text, the destructive outline's label |

All existing (`styles.css`). Rules:

- **Text that carries information is `ink-dim` or brighter**: 4.5:1 or better
  on every well in both themes. `ink-faint` and `ink-ghost` never carry it
  (MMR-718).
- **A form field has no placeholder.** A prompt for what to write ("What is
  this project for?") is help text under the control, 13/20 `ink-dim`
  (6.6:1 dark, 5.5:1 light on `well-850`), so it stays visible once the
  field holds a value. **Proposed**: today Description's prompt is a
  placeholder in `ink-faint`, 2.7:1 dark and 2.2:1 light. Outside a form,
  where a placeholder remains (a search box), it is `ink-dim`: 7.2:1 dark,
  5.2:1 light on `well-950`.
- **A disabled commit is a quiet button, not a faded one.** Fill `well-800`,
  label `ink-dim` (6.4:1 dark, 5.1:1 light on `well-800`), and a 1px
  `line-bright` inset edge so the shape holds on a `well-850` footer (the
  fill alone differs by 1.04:1 dark, 1.08:1 light). Disabled controls are
  exempt from the 3:1 edge rule, but their label still meets 4.5:1.
  **Proposed**: today `disabled:opacity-40`, which drops the label to about
  2:1.
- **Surfaces, from deepest to most raised**: `well-950` (top bar, input
  ground), `well-900` (page), `well-850` (card, panel, menu), `well-800`
  (nested block). Depth is tone, not shadow, in dark; light adds the
  `shadow-card` / `shadow-menu` / `shadow-overlay` ramp (existing).
- **Form surfaces: the panel is `well-850` and a control's ground is
  `well-950`.** **Proposed**: the Drawer and Dialog panels are `well-900` today,
  and a `well-950` input on `well-900` differs by under 2% luminance, so the
  control reads only by its edge.
- **The overlay scrim** is `well-950` at 70% with a 2px blur (existing,
  `OVERLAY_BACKDROP_CLASS`).
- **Control edges meet 3:1 against the surface they sit on.** Where the edge
  is what identifies the control (Input, Textarea, Select trigger, Segmented
  track, Combobox, a menu that floats over the sheet, an outline button), the
  edge is `ink-faint`: 3.2:1 on `well-850` in dark, 3.1:1 in light. Hover
  raises it to `ink-dim`. **Proposed**: `TEXT_FIELD_CLASS` uses `line-bright`,
  which measures 1.4:1 dark and 1.5:1 light, so a field on a sheet reads only
  by its ground. Checkbox and radio boxes already use `ink-dim` (existing).
  `line` and `line-bright` stay for structure: rules, panel edges, a toast's
  edge, never the edge that tells you where to type.
- **Accent is a wash, never a surface fill.** A selected segment is
  `accent/12` with a 1px `accent` inset ring, inset 2px clear of the track's
  1px edge on every side, so the first and last segments never double the
  track border (wash existing,
  `segmented-control.tsx`; full-strength ring **proposed**, because the
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
| Label and its control | 8 | **proposed**: `Field` is `gap-1.5` (6); a 14px label needs more air |
| Control and its help or error | 8 | **proposed**: same reason |
| Label and the optional marker on its line | 8, baseline-aligned | **proposed** |
| One field and the next | 24 | **proposed**: today's sheets use 12–16, the measured cause of cramming |
| A lone checkbox row after a field | 24 from the control above to the row's text; the row's extra height is pulled back with a negative margin | **proposed** |
| One group and the next | 32, a `line` hairline, then 24 | **proposed** |
| Group heading (ink-bright 16/600) and its first label (ink 14/500) | 20, line box to line box. A collapsible heading is a 44 (phone) or 36 (desktop) button; its extra height is pulled back so the visible 20 holds | **proposed** |
| Group heading and its explanation (Lifecycle's paragraph) | 12, line box to line box: the paragraph belongs to the heading more tightly than a field does | **proposed** |
| Help line and the button it explains (Archive) | 16 | **proposed** |

Help is not bound by a narrow control: the Key input is 128 wide, and its
help starts 8 below it and wraps at the 440 help measure, not the input's
edge.

A form should not need a stacked choice list: four or fewer options are a
Segmented Control, more are a Select. If one remains, it follows these numbers:

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
| Side padding: header, body, footer | 20 | 32 | **proposed**: Drawer is `p-4` (16) at every width |
| Header | 20 top and bottom after `env(safe-area-inset-top)`: 68 tall with a title alone, 92 with a context line. The close's 44 hit area centers on the title line | 28 top, 20 bottom; the close's 36 hit area centers on the title line | **proposed** |
| Body | 24 top, 32 bottom | 32 top, 40 bottom | **proposed** |
| Footer | 12 top, 12 + `env(safe-area-inset-bottom)` bottom | 16 top and bottom | **proposed** |
| Footer note ("Joins the project list on the review page.") | one line, 13/20 `ink-dim`, directly above the full-width commit inside the bottom bar, 8 above it | left of the footer, vertically centred on Cancel and the commit, at least 16 clear of Cancel | **proposed**: today in the body; the source keeps it in the footer row |
| Title and context line | 4 | 4 | **proposed** |
| Buttons in a row | 12 | 12 | **proposed**: `DialogFooter` is `gap-2` (8) |
| Dialog (a question) | 20 all round, 16 between blocks | 24 all round, 16 between blocks | **proposed**: today `p-4 gap-3` |

Header and footer are separated from the body by a `line` hairline, and both
stay put while the body scrolls. Nothing below a form's commit row scrolls.

- **A footer note says what the commit leads to,** so it lives with the
  commit, not under the last field. It is the commit's `aria-describedby`.
- **When content is scrolled above the fold,** the pinned header gains a
  hairline shadow (`0 1px 0` plus a 4px soft drop: black 35% and 45% in
  dark, `#17242f` at 6% and 10% in light) that disappears at the top.
- **A still or a restored scroll rests on whole-field boundaries:** neither
  bar cuts through a field, a group heading, or a choice row's text, so a
  label is never parted from its control.
- **Initial focus goes to the first field** (System in Launch in T3, Seed in
  File a seed, Title in New project), not to a later control.

### Toast (the Notice)

| Where | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Place | top, 8 below the app bar's bottom hairline, 16 from the sides; it never covers the bar or sits on its hairline, and clears the page title by 16 or more | bottom left of the content area, 16 from its edges (so 16 clear of the sidebar), 356 wide | **proposed**: `toast.tsx` places it 16 below the viewport top on a phone, over the app bar, and 16 from the window's left edge on desktop, over the sidebar |
| Surface | `well-850`, 1px `line-bright` edge, `shadow-menu` in light, none in dark, 8 radius | same | **proposed**: today `well-900` (the page's own fill) with `shadow-2xl` |
| Padding | 4 around the action, 16 before the text | same | **proposed** |
| Text | 14 / 20 ink; the record's name ink-bright 600 | same | **proposed** |
| Action | `accent-foreground` 600 text button, named for its effect ("Undo") | same | ADR 0019 |

A Toast is raised like a menu, not dropped like a dialog: it borrows the menu's
surface and shadow so it reads above the page without darkening it.

### Pages

| Where | Value | Mark |
| --- | --- | --- |
| Page gutter | 20 (`p-5`); 14 on a phone where cards run edge to edge (`max-md:px-3.5`) | existing (`record-layout.tsx`, `focus-queue.tsx`) |
| Between page sections | 24–40 | existing range (`/kit` uses 40) |

## Sizes

| Control | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Input, Select trigger, Combobox | 44 tall | 44 tall | existing for Input (`h-11`); **proposed** for Select (`min-h-9`, 36) so a form's controls share one height |
| Segmented track | 50: a 3px inset (the 1px edge, then 2 clear) leaves each segment a 44 tap target; segments share the width | 44, segments 38, content width with 20 side padding | **proposed**: today about 28 |
| Textarea | 3 lines: 88 (22 × 3 + 22 padding); grows by line | same | existing line height; height **proposed** |
| Segmented segment text | 14 / 500, sentence case | same | **proposed**: today the 10.5px uppercase microlabel |
| Choice row (radio, checkbox, switch) | 44 min | 36 min | 44 existing for Switch rows (ADR 0019 MMR-712); 36 **proposed** |
| Radio and checkbox box | 16 | 16 | existing (`size-4`) |
| Switch | 40 × 24 | 40 × 24 | existing |
| Footer button | 44, full width for the commit | 44, content width, 20 side padding, the height of the controls above it | **proposed**: ActionButton `sm` renders about 28 tall in 12px |
| Commit while the form cannot be sent | `disabled` until the required fields hold a value (File seed: text; Create project: a title and a key); Save stays enabled while the title is set. Drawn as the quiet disabled button under Color roles, never faded | same | `disabled` condition existing; the look **proposed** (today `disabled:opacity-40`) |
| Close and icon buttons | 44 hit area, 20 glyph | 36 hit area, 18 glyph | **proposed** |
| Menu row in a Sheet | 44 | 36 | 44 existing (ADR 0019 MMR-736); 36 **proposed** for 15px rows (Select item is `min-h-8`, 32, in 13px) |
| Toast action (Undo) | 44 tall, 64 wide at least | 36 | **proposed** |

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
| Control edge | 1px `ink-faint`, `ink-dim` on hover, `status-blocked` when invalid, `accent` on focus | **proposed** `ink-faint` (today `line-bright`, 1.4:1); invalid existing (`TEXT_FIELD_CLASS`) |
| Focus on a field (Input, Textarea, Select trigger, Combobox) | the edge itself turns `accent` and a 1px `accent` outline at offset 0 joins it: one 2px ring at the control's edge, never a frame inside a frame. 8.7:1 dark, 3.7:1 light on `well-850` | existing border turn (`focus-visible:border-accent`); the joined outline **proposed** |
| Focus on a segment | 2px `accent` outline at offset −2, inset inside the segment; while focused it replaces the selection ring (the wash stays). 7.7:1 dark, 3.0:1 light on the wash | **proposed**: today the button ring, 2px out, which collides with the track |
| Focus on a button, checkbox, or the close | 2px `accent` outline, 2px offset | existing (`actionButtonVariants`) |
| A menu over a sheet | `well-800`, 1px `ink-faint` edge, `shadow-menu` in light, 8 radius, 4 inset | **proposed**: `SelectContent` is `well-850` with `line-bright`, which vanishes over a `well-850` sheet |
| A Select's menu, desktop | opens 8 below the trigger, which clears the trigger's 1px focus ring by 7; at least the trigger's width. It either covers every block below it whole (a field, a hairline, a heading) or ends at least 12 above the next one; if neither fits, it flips above or caps its height and scrolls. Groups are set off by their heading (12 above it after the first group), not by a rule | **proposed** |
| A Select's menu, phone | a bottom list: a content-sized bottom sheet over the overlay scrim, `well-850`, 12 top corners, a decorative `ink-faint` grip, the field's label as a 16/600 heading, 44 rows with text at the 20 gutter, a tick on the chosen row, and the home-indicator inset below the last row | **proposed**: a popover on a phone lands over the next fields and cuts them |

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
| Prose measure | 70ch max | existing practice (walkthrough uses 62ch) |

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
