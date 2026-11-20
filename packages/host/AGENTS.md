# The console (`packages/host`)

The console is React on UI SDK (`@ui-sdk/react` over `@ui-sdk/core`), its
only headless library ([ADR 0046](../../docs/decisions/0046-console-primitives-on-ui-sdk.md)).

Build and review console UI to the numbers in [DESIGN.md](DESIGN.md): type,
color roles, spacing, control sizes, radii, and layout widths.

## Using UI SDK

- Before you use UI SDK, follow the `ui-sdk` skill and read
  `node_modules/@ui-sdk/react/docs/llms.txt`. Both match the installed
  version; read the pages of the components you use.
- Read `node_modules/@ui-sdk/react/docs/core.md` (search it by heading) and
  `rendering.md` beside it only when you build a component UI SDK does not
  ship.
- UI SDK is pinned to one exact version in `package.json`. An upgrade is its
  own change, confined to `src/components/ui`, and refreshes the committed
  skill by replacing `skills/ui-sdk/` with `node_modules/@ui-sdk/core/skills/ui-sdk`
  (`rm -rf skills/ui-sdk && cp -R packages/host/node_modules/@ui-sdk/core/skills/ui-sdk skills/`
  from the repository root), so a file the package dropped goes too.

## Three layers

| Layer | Directory | May import |
| --- | --- | --- |
| Primitives | `src/components/ui` | `@ui-sdk/*` and the Meridian tokens |
| Patterns | `src/components/patterns` | Primitives only |
| Features | Everything else | Patterns, and the plain parts in `src/components/ui` |

- Only `src/components/ui` imports `@ui-sdk/*`. A lint rule enforces it, so an
  import anywhere else fails `bun run verify`.
- Primitives style UI SDK's unstyled parts with the Meridian tokens through
  their `data-slot` and state attributes. UI SDK's `web.css` is not used.
- The plain parts (`ActionButton`, `IconButton`, `Badge`, `Card`, the icons,
  and `Skeleton`) wrap no UI SDK behavior, and a feature uses them directly.
- A feature never builds an overlay or an input from a primitive. It uses the
  pattern for that kind of input, as ADR 0019's MMR-736 refinement defines
  them. A shape no pattern provides is added to ADR 0019 first.
- Every primitive is shown in `/kit` (dev only) in both themes.
