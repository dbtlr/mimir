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
  'no-await-in-loop': 'off', // 57 — many are intentional sequential I/O
  'no-nested-ternary': 'off', // 4
  'no-shadow': 'off', // 4
  'typescript/no-unsafe-type-assertion': 'off', // JSON sites migrated to parseJson; ~83 non-JSON casts remain
  'unicorn/consistent-function-scoping': 'off', // 7
  'unicorn/custom-error-definition': 'off', // 1
  'unicorn/no-nested-ternary': 'off', // 4
  'vitest/no-conditional-expect': 'off', // 4
  // contradicts vitest/prefer-called-once (which we keep) — opposite preferences,
  // both on by default; can't satisfy both, so this twin stays off.
  'vitest/prefer-called-times': 'off',
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
  // react plugins are enabled here (the ui override), so these must be disabled at
  // the same scope to win. No-count entries are the react-target defaults we keep;
  // counted entries are conformance backlog (walk down one at a time).
  rules: {
    'jsx-a11y/no-autofocus': 'off', // 1
    'jsx-a11y/prefer-tag-over-role': 'off', // 3
    'react-perf/jsx-no-jsx-as-prop': 'off', // 1
    'react-perf/jsx-no-new-array-as-prop': 'off', // 13
    'react-perf/jsx-no-new-function-as-prop': 'off', // 95
    'react-perf/jsx-no-new-object-as-prop': 'off', // 21
    'react/hook-use-state': 'off', // 1
    'react/jsx-max-depth': 'off',
    'react/jsx-props-no-spreading': 'off',
    'react/react-in-jsx-scope': 'off', // React 19 jsx-runtime — no import needed
    'unicorn/filename-case': 'off',
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
  // Kysely migrations use an ordered `NNNN_name` filename convention, not
  // kebab/pascal — exempt the whole directory from filename-case.
  { files: ['packages/bin/src/db/migrations/**'], rules: { 'unicorn/filename-case': 'off' } },
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
