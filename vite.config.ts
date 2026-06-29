import { toolingConfig } from '@dbtlr/tooling';
import type { LintOverride } from '@dbtlr/tooling/vite-plus';

type Override = LintOverride;

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
 * Conformance backlog — @dbtlr/tooling's rules are best practices we adopt.
 * Everything auto-fixable has already been conformed (`vp lint --fix`); these
 * are the non-auto-fixable residual, disabled to keep `vp check` green while we
 * WALK THEM DOWN ONE AT A TIME: remove a line, fix the code (inline-disable only
 * the true exceptions), commit, repeat. Counts are at the time of capture.
 */
const quarantinedRules: Record<string, 'off'> = {
  // — eslint core —
  curly: 'off', // 21 (autofix residual)
  'no-await-in-loop': 'off', // 57 — many are intentional sequential I/O
  'no-nested-ternary': 'off', // 4
  'no-shadow': 'off', // 4
  'no-unused-vars': 'off', // 35
  'sort-keys': 'off', // 52 (autofix residual — spread/comment objects)
  // — typescript —
  'typescript/no-unsafe-type-assertion': 'off', // 146 — biggest; mostly test JSON.parse casts
  // — import —
  'import/no-unassigned-import': 'off', // 2
  // — unicorn —
  'unicorn/consistent-function-scoping': 'off', // 7
  'unicorn/custom-error-definition': 'off', // 1
  'unicorn/filename-case': 'off', // 6
  'unicorn/no-nested-ternary': 'off', // 4
  'unicorn/prefer-global-this': 'off', // 5
  'unicorn/prefer-set-has': 'off', // 1 — autofix is unsound here (array→Set vs array type)
  // — vitest (lints all files, not just *.test.*) —
  'vitest/no-conditional-expect': 'off', // 4
  'vitest/prefer-called-once': 'off', // 1
  'vitest/require-hook': 'off', // 6 (fires on test helpers + app files)
  'vitest/require-top-level-describe': 'off', // 1
  // — promise —
  'promise/avoid-new': 'off', // 1
  'promise/param-names': 'off', // 1
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
    // conformance backlog (walk down one at a time) — react plugins enable these
    // via the ui override, so they must be disabled at the same scope to win.
    'jsx-a11y/no-autofocus': 'off', // 1
    'jsx-a11y/prefer-tag-over-role': 'off', // 3
    'react-perf/jsx-no-jsx-as-prop': 'off', // 1
    'react-perf/jsx-no-new-array-as-prop': 'off', // 13
    'react-perf/jsx-no-new-function-as-prop': 'off', // 95
    'react-perf/jsx-no-new-object-as-prop': 'off', // 21
    'react/hook-use-state': 'off', // 1
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
    overrides: layerOverrides,
    rules: quarantinedRules,
  },
  node: ['packages/bin/**'],
});
