import { toolingConfig } from '@dbtlr/tooling';
import type { JsonObject } from '@dbtlr/tooling';
import type { OxlintConfig } from 'oxlint';

type Override = NonNullable<OxlintConfig['overrides']>[number];

/**
 * Centralized monorepo lint config (@dbtlr/tooling).
 *
 * The Bun `workspaces` array in package.json marks this tree a monorepo, so
 * vite-plus centralizes lint/fmt here — per-package `lint` blocks are ignored
 * (only Vite/Vitest/build config is honored per package). `toolingConfig`'s
 * `node`/`react` take glob lists to scope each target to its package:
 *   - `packages/bin/**`  is the Bun binary (db/core/CLI/MCP/HTTP) — `node` is
 *     the closest shipped target (allows `node:` builtins). NOTE: there is no
 *     `bun` target yet, so `bun:*` imports and the `Bun` global are not covered.
 *   - `packages/contract/**` is pure types under the browser baseline (no glob).
 *
 * The React SPA (`packages/ui`) does NOT use toolingConfig's `react` target.
 * That target enables react/react-perf/jsx-a11y as a bundle and activates their
 * rules via the `perf`/`correctness` categories; because vite-plus orders the
 * target's override last, a consumer cannot turn individual rules back off from
 * `lint.overrides`. So we replicate the target by hand in `uiLintOverride` —
 * same plugins, but we own the rule severities (quarantine the noisy ones,
 * keep correctness like rules-of-hooks). Re-enable one at a time there.
 *
 * Layer-boundary enforcement (the one thing toolingConfig can't express) rides
 * through `lint.overrides`. Inside `@mimir/bin` the flow is
 * `contract ← db ← core ← transports`:
 *   - `db` may import `contract`, never `core`/transports.
 *   - `core` may import `db` + `contract`, never transports.
 *   - transports import `core` + `contract`, never `db` or each other.
 * `main.ts` is the composition root and is intentionally unrestricted.
 *
 * Patterns match the relative import specifiers we actually write (`../core/x`,
 * `../../db/y`); `**` spans the leading `..` segments. Brace/extglob `@(...)`
 * forms are avoided — oxlint silently ignores them in `overrides[].files`.
 */
const layerGroups = (layer: string): string[] => [`**/${layer}`, `**/${layer}/**`];

const forbid = (files: string[], layers: string[]): Override => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: layers.flatMap(layerGroups),
            message: `Layer boundary: ${files[0]} may not import from ${layers.join(', ')} (contract <- db <- core <- transports).`,
          },
        ],
      },
    ],
  },
});

/**
 * Quarantined rules — @dbtlr/tooling's strict default flags these against the
 * existing codebase, none are safely auto-fixable, and most are stylistic
 * preference rather than correctness. Disabled wholesale to land a green
 * `vp check`; we re-enable them ONE AT A TIME (fix the code or keep it off,
 * deliberately) rather than accept a 1.4k-violation wall. Grouped by the triage
 * buckets so each line is an informed re-enable decision.
 *
 * Tracking: the cleaner fix for the preference rules is upstream in the strict
 * preset; this list is Mimir's interim shim.
 */
const quarantinedRules: Record<string, 'off'> = {
  // — Style / preference, not safe-autofixable, fights Mimir's conventions —
  curly: 'off',
  'func-style': 'off', // Mimir mixes declaration + expression by design (475)
  'import/exports-last': 'off',
  'import/first': 'off',
  'new-cap': 'off',
  'no-await-in-loop': 'off', // intentional sequential SQLite ops (57)
  'no-nested-ternary': 'off',
  'sort-keys': 'off',
  'typescript/consistent-return': 'off',
  // its autofix converts `interface`→`type`, which breaks module augmentation
  // (TanStack Router's `interface Register` → TS2300 duplicate + lost inference).
  'typescript/consistent-type-definitions': 'off',
  'typescript/consistent-type-imports': 'off',
  'typescript/method-signature-style': 'off',
  'typescript/parameter-properties': 'off',
  'unicorn/consistent-function-scoping': 'off',
  'unicorn/custom-error-definition': 'off',
  'unicorn/filename-case': 'off',
  'unicorn/no-nested-ternary': 'off',
  'unicorn/no-useless-collection-argument': 'off',
  'unicorn/prefer-export-from': 'off',
  'unicorn/prefer-global-this': 'off',
  'unicorn/prefer-response-static-json': 'off',
  'unicorn/prefer-set-has': 'off',

  // (React/react-perf/jsx-a11y rules are quarantined in `uiLintOverride`, not
  // here — they need the ui-scoped override to win, see the header comment.)

  // — Test style (vitest) — opinionated, applies to the UI suite —
  'vitest/max-expects': 'off',
  'vitest/no-conditional-expect': 'off',
  'vitest/no-hooks': 'off',
  // its "safe" autofix rewrites toHaveBeenCalled() → toHaveBeenCalledWith(),
  // changing "called at all" into "called with zero args" — breaks real tests.
  'vitest/prefer-called-with': 'off',
  // its autofix replaces a string title with the first identifier even when it
  // isn't a function (`describe(SOME_ARRAY)` / `describe(zodSchema)` → TS2769).
  'vitest/prefer-describe-function-title': 'off',
  'vitest/prefer-called-times': 'off',
  // its autofix rewrites vi.mock('x') → vi.mock(import('x')), which breaks the
  // typed-mock overloads (TS2769/TS2300); keep off until that's sound upstream.
  'vitest/prefer-import-in-mock': 'off',
  'vitest/require-hook': 'off',
  'vitest/require-mock-type-parameters': 'off',
  'vitest/require-top-level-describe': 'off',
  'vitest/valid-title': 'off',

  // — Genuine correctness — re-enable + fix in code FIRST when we triage —
  'typescript/no-unsafe-type-assertion': 'off', // risky `as` (149, mostly test JSON.parse)
  'typescript/no-unnecessary-type-assertion': 'off',
  'typescript/no-unnecessary-type-conversion': 'off',
  'typescript/no-unnecessary-type-parameters': 'off',
  'no-shadow': 'off',
  'no-unused-vars': 'off', // partly autofix residue
  'no-duplicate-imports': 'off',
  'import/no-duplicates': 'off',
  'import/no-unassigned-import': 'off',
  'promise/avoid-new': 'off',
  'promise/param-names': 'off',
};

/**
 * Hand-rolled replacement for toolingConfig's `react` target (see header). Same
 * plugin bundle, but we own the severities: replicate the target's own opt-outs,
 * keep react correctness (rules-of-hooks etc.) live, and quarantine the noisy
 * react-perf / jsx-a11y / react-style rules. Re-enable one at a time here.
 */
const uiLintOverride: Override = {
  files: ['packages/ui/**'],
  plugins: ['react', 'react-perf', 'jsx-a11y'],
  rules: {
    // toolingConfig's react-target defaults (replicated verbatim)
    'react/jsx-max-depth': 'off',
    'react/jsx-props-no-spreading': 'off',
    'react/react-in-jsx-scope': 'off', // React 19 jsx-runtime — no import needed
    'unicorn/filename-case': 'off',
    // quarantined — re-enable individually
    'jsx-a11y/no-autofocus': 'off',
    'jsx-a11y/prefer-tag-over-role': 'off',
    'react-perf/jsx-no-jsx-as-prop': 'off',
    'react-perf/jsx-no-new-array-as-prop': 'off',
    'react-perf/jsx-no-new-function-as-prop': 'off',
    'react-perf/jsx-no-new-object-as-prop': 'off',
    'react/hook-use-state': 'off',
  },
};

const layerOverrides: Override[] = [
  forbid(['packages/bin/src/db/**'], ['core', 'cli', 'mcp', 'http']),
  forbid(['packages/bin/src/core/**'], ['cli', 'mcp', 'http']),
  forbid(['packages/bin/src/cli/**'], ['db', 'mcp', 'http']),
  forbid(['packages/bin/src/mcp/**'], ['db', 'cli', 'http']),
  forbid(['packages/bin/src/http/**'], ['db', 'cli', 'mcp']),
  // Tests legitimately wire layers together (fixtures from `db/testing`,
  // cross-layer assertions); the boundary constrains shipped code, not tests.
  { files: ['**/*.test.ts'], rules: { 'no-restricted-imports': 'off' } },
  uiLintOverride,
];

export default toolingConfig({
  fmt: {
    // machine-written (scripts/generate-ui-assets.ts) and gitignored
    ignores: ['**/*.generated.ts'],
  },
  lint: {
    ignores: ['dist/**', '**/*.generated.ts'],
    // toolingConfig types `overrides` as the opaque `JsonObject[]`; our typed
    // oxlint fragments don't carry an index signature, so cast at the boundary.
    overrides: layerOverrides as unknown as JsonObject[],
    rules: quarantinedRules,
  },
  node: ['packages/bin/**'],
});
