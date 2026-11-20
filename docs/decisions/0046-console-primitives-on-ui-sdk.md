---
title: 'ADR 0046: The console builds on UI SDK primitives and a fixed set of patterns'
status: accepted
date: 2026-11-20
---

# ADR 0046: The console builds on UI SDK primitives and a fixed set of patterns

[ADR 0013](0013-ui-embedded-spa.md) chose shadcn/ui in its Base UI flavor for
the console's components. The console kept a thin vendored layer in
`packages/host/src/components/ui/`, but features did not have to go through
it. By 2026-11-20 eleven feature files imported Base UI's Dialog directly,
and the console asked the operator for input in 42 places built in more
shapes than their jobs needed:

- four confirm shapes;
- two copies of the reason dialog's frame;
- four hand-built search pickers;
- three forms for a task's fields;
- two places that build the same actions twice, once for a phone and once
  for desktop.

Each new ask started by choosing a shape. This record settles which headless
library the console builds on, and the rule that keeps features from
building their own shapes. [ADR 0019](0019-meridian-console-design-system.md)'s
MMR-736 refinement holds the pattern set itself.

## Decision

### UI SDK is the console's only headless library

The console's interactive behavior (focus, dismissal, keyboard navigation,
popups, dragging, and the ARIA they need) comes from UI SDK: `@ui-sdk/react`
over `@ui-sdk/core`, from Vercel Labs, under Apache-2.0. Base UI
(`@base-ui-components/react`) and Sonner leave the console. UI SDK's Toast
replaces Sonner.

UI SDK ships unstyled parts. The console styles them with the Meridian
tokens through their `data-slot` and state attributes, and uses none of UI
SDK's `web.css`. The global stylesheet declares `@layer ui-sdk;` as its first
line, so the console's styles win over the small amount of CSS UI SDK
injects.

### Three layers, one import rule

| Layer | Directory | Holds | May import |
| --- | --- | --- | --- |
| Primitives | `components/ui` | UI SDK parts styled with the Meridian tokens | `@ui-sdk/*` and the tokens |
| Patterns | `components/patterns` | The input patterns and feed blocks that ADR 0019 names | Primitives only |
| Features | Everything else | Pages, routes, and record views | Patterns, and the plain parts in `components/ui` that wrap no UI SDK behavior |

- Only `components/ui` imports `@ui-sdk/*`. A lint rule enforces this, so an
  import anywhere else fails `verify`.
- The plain parts are `ActionButton`, `IconButton`, `Badge`, `Card`, the
  icons, and `Skeleton`. A feature uses them directly, for example for a
  one-tap action. A feature never builds an overlay or an input from a
  primitive itself; it uses the pattern for that kind of input.
- A feature that needs a shape no pattern provides adds the pattern to ADR
  0019 first. A new pattern is a design decision, not an implementation
  detail of one feature.
- The primitives ADR 0019 names are built together before the redesign
  builds on them. Each pattern is built by the first task that needs it, to
  the definition ADR 0019 gives.

### The version is pinned exactly

UI SDK is a public beta whose APIs may change. `packages/host/package.json`
pins `@ui-sdk/react` and `@ui-sdk/core` to one exact version, first
`0.1.0-beta.13`. An upgrade is its own change, confined to `components/ui`,
with the console's tests and `/kit` as its check.

### Agents read the installed docs

UI SDK ships Markdown docs and an agent skill inside its packages, matched to
the installed version. The skill is committed at `skills/ui-sdk/`, copied
from `@ui-sdk/core` at the pinned version, with `.claude/skills/ui-sdk` and
`.agents/skills/ui-sdk` as symlinks to it. A check fails `verify` when the
committed copy differs from the installed package's copy. `packages/host/AGENTS.md`
(with `packages/host/CLAUDE.md` as a symlink to it) points agents at
`node_modules/@ui-sdk/react/docs/llms.txt`, the skill, and the import rule
above.

### Base UI leaves as its asks move

The asks move onto patterns in the redesign's tasks. An ask that a later
redesign task retires moves with that task, not before it. Base UI and Sonner
are removed from `packages/host` once the last import is gone.

## Why

- **The duplication came from a missing rule, not a missing library.** The
  import rule and the fixed pattern set fix it on any headless library. They
  are the larger part of this decision.
- **UI SDK covers the redesign's shapes with fewer custom parts.**
  - Its Drawer drags, rests on snap points, and handles the on-screen
    keyboard. The redesign's preview panel, edit sheet, and filter sheet all
    need that on a phone.
  - Its Command, Combobox, and Listbox cover the four hand-built pickers.
  - Its Collapsible, Tabs, Segmented Control, Switch, and Toast cover the
    redesign's day folds, record tabs, choices, and notices.
- **It is built for agent work.** Each package ships docs matched to the
  installed version, plus a skill that gives an agent a workflow for choosing
  parts and testing keyboard, focus, and ARIA.
- **A proof passed on this stack (MMR-738).** UI SDK built into the TanStack
  Start server and client bundles. The production host served it.
  `renderToString` produced each component's ARIA state with no errors.
  Nineteen desktop checks of Dialog, Drawer, Switch, and Menu passed with no
  console errors. The operator's checks of the console installed to an
  iPhone's Home Screen passed. The console is client-rendered today (its
  shell is `ClientOnly`), so server rendering is a capability kept, not one
  in use.
- **The vendored-source reason in ADR 0013 still holds where it mattered.**
  UI SDK is headless, so the look and the components stay the console's own
  code. Only behavior is imported, which the console never crafted.

## Considered and rejected

- **Keep Base UI and add only the import rule.** It fixes the duplication.
  But it leaves the phone sheets, pickers, and choices to be built by hand
  on Base UI, which offers less of what the redesign needs.
- **Adopt UI SDK for new work only.** Base UI would stay under the screens
  the redesign does not touch. Two headless libraries would then serve the
  same jobs indefinitely, and the old asks would never match the new
  patterns.
- **Build primitives as each redesign task needs them.** Each task would then
  decide how a primitive looks, which is the per-feature shape choice this
  record removes.
- **Use UI SDK's `web.css` default look.** The Meridian tokens are the
  console's look ([ADR 0019](0019-meridian-console-design-system.md)), and a
  second set of defaults would compete with them.

## Consequences

- **The bundle grows.**
  - Lazy-loaded with the routes that use them, UI SDK's parts left the first
    load nearly unchanged in the proof: 1.3 KB gzip.
  - Bundled alone, the four proof parts are 76 KB gzip, against 60 KB for
    the four Base UI parts the console imported.
  - A likely twelve-primitive set is 111 KB gzip.
  - After Base UI leaves, the expected net growth is roughly 15 to 50 KB
    gzip, depending on the final set and how much of it the first page loads.
  - Primitives used by only some routes stay out of the first chunk.
- **A beta upgrade can break the primitives.** The exact pin and the one
  directory that imports UI SDK keep that break in one place.
- **A Content Security Policy must allow UI SDK's injected styles.** The host
  sends none today. Adding one later must allow these styles, or pass UI
  SDK the policy's nonce.
- **The lint rule that associates labels with controls** does not recognize
  UI SDK's Switch inside a wrapping `<label>`. The primitives configure the
  rule, or pair the label and control with `htmlFor` and `id`.
- **ADR 0013's stack line changes** as its MMR-736 refinement records, and
  ADR 0019's MMR-736 refinement holds the patterns features build from.
