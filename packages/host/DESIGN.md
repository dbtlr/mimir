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
| Help, context line, meta | 13 / 20 | 400 | ink-dim | `text-meta` | **proposed** for help: `FieldDescription` is 12px ink-faint (2.6:1 on light) |
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
- **Measure.** Prose wraps at 70 characters at most; help text in a form at
  the control's width (576px at most in the 640 Sheet).
- **Mono sizes match their neighbors.** An ID inside a 13px meta line is 13px
  mono, not a smaller step.

## Color roles

Use roles, never raw hex. Dark is the default theme; light overrides the same
tokens under `[data-theme='light']` (existing, `styles.css`). Contrast figures
are measured against `well-850` / `well-900` / `well-950`.

| Role | Token | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| Primary text | `ink-bright` | 15.1 / 15.9 / 16.3 | 15.8 / 13.6 / 14.9 | titles, control values, headings |
| Body text | `ink` | 10.0 / 10.6 / 10.8 | 9.3 / 8.0 / 8.8 | prose, field labels |
| Secondary text | `ink-dim` | 6.6 / 7.0 / 7.2 | 5.5 / 4.8 / 5.2 | help, meta, context line, optional marker |
| Faint | `ink-faint` | 3.2 / 3.4 / 3.5 | 3.1 / 2.6 / 2.9 | non-text only: an off switch, a grip, disabled glyphs |
| Ghost | `ink-ghost` | 2.5 / 2.6 / 2.7 | 2.3 / 2.0 / 2.2 | placeholders that carry no information |
| Accent | `accent`, `accent-foreground` | 8.7, 10.5 on 850 | 3.7, 6.8 on 850 | focus, selection washes, links (`-foreground` as text) |
| Action | `action` / `action-foreground` | 8.0:1 | 9.5:1 | the one solid button per surface |
| Danger | `status-blocked-foreground` | 8.7 on 850 | 6.3 on 850 | error text, the destructive outline's label |

All existing (`styles.css`). Rules:

- **Text that carries information is `ink-dim` or brighter**: 4.5:1 or better
  on every well in both themes. `ink-faint` and `ink-ghost` never carry it
  (MMR-718).
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
- **Accent is a wash, never a fill**: a selected segment or option is
  `accent/12` with an `accent/24` inset ring (existing, `segmented-control.tsx`).
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
| Choice options stacked (radio, checkbox) | 0; each row carries its own height | **proposed** |
| One group and the next | 32, a `line` hairline, then 24 | **proposed** |
| Group heading and its first field | 16 | **proposed** |
| Help line and the button it explains (Archive) | 16 | **proposed** |

### Sheets, panels, dialogs

| Where | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Side padding: header, body, footer | 20 | 32 | **proposed**: Drawer is `p-4` (16) at every width |
| Header | 56 tall top bar: title, context line below it, close at the right edge; 12 top and bottom | 28 top, 20 bottom; close aligned to the title's first line | **proposed** |
| Body | 24 top, 40 bottom | 32 top, 40 bottom | **proposed** |
| Footer | 12 top, 12 + `env(safe-area-inset-bottom)` bottom | 16 top and bottom | **proposed** |
| Title and context line | 4 | 4 | **proposed** |
| Buttons in a row | 12 | 12 | **proposed**: `DialogFooter` is `gap-2` (8) |
| Dialog (a question) | 20 all round, 16 between blocks | 24 all round, 16 between blocks | **proposed**: today `p-4 gap-3` |

Header and footer are separated from the body by a `line` hairline, and both
stay put while the body scrolls. Nothing below a form's commit row scrolls.

### Pages

| Where | Value | Mark |
| --- | --- | --- |
| Page gutter | 20 (`p-5`); 14 on a phone where cards run edge to edge (`max-md:px-3.5`) | existing (`record-layout.tsx`, `focus-queue.tsx`) |
| Between page sections | 24–40 | existing range (`/kit` uses 40) |

## Sizes

| Control | Phone (< 768) | Desktop (≥ 768) | Mark |
| --- | --- | --- | --- |
| Input, Select trigger, Segmented track, Combobox | 44 tall | 44 tall | existing for Input (`h-11`); **proposed** for Select (`min-h-9`, 36) and Segmented (about 28) so a form's controls share one height |
| Textarea | 3 lines: 88 (22 × 3 + 22 padding); grows by line | same | existing line height; height **proposed** |
| Segmented segment text | 14 / 500, sentence case | same | **proposed**: today the 10.5px uppercase microlabel |
| Choice row (radio, checkbox, switch) | 44 min | 36 min | 44 existing for Switch rows (ADR 0019 MMR-712); 36 **proposed** |
| Radio and checkbox box | 16 | 16 | existing (`size-4`) |
| Switch | 40 × 24 | 40 × 24 | existing |
| Footer button | 44, full width for the commit | 40, content width, 16 side padding | **proposed**: ActionButton `sm` renders about 28 tall in 12px |
| Close and icon buttons | 44 hit area, 20 glyph | 36 hit area, 18 glyph | **proposed** |
| Menu row in a Sheet | 44 | 32 (Select item `min-h-8`) | existing (ADR 0019 MMR-736; `select.tsx`) |

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
| Control edge | 1px `line-bright`; `accent` on focus; `status-blocked` when invalid | existing (`TEXT_FIELD_CLASS`) |
| Focus ring on buttons and segments | 2px `accent` outline, 2px offset | existing (`actionButtonVariants`) |

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
│ Title                    [×] │ 56     │ Title                            [×] │ 28 / 20
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
│ 16 …                         │        │ 16 …                                 │
│ 40                           │        │ 40                                   │
├──────────────────────────────┤ line   ├──────────────────────────────────────┤
│ [        Commit         44 ] │ 12     │                   [Cancel] [Commit]  │ 16, 40 tall
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
