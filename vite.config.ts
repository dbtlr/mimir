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
 *   - `packages/bin/**`  is the Bun binary (core/CLI/MCP/HTTP) — `node` is
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
 * `contract ← core ← transports`:
 *   - `core` may import `contract` (and the `norn`/`vault` seam), never transports.
 *   - transports import `core` + `contract`, never each other.
 * `main.ts` is the composition root and is intentionally unrestricted.
 *
 * Patterns match the relative import specifiers we actually write (`../core/x`,
 * `../../core/y`); `**` spans the leading `..` segments. Brace/extglob `@(...)`
 * forms are avoided — oxlint silently ignores them in `overrides[].files`.
 */
const layerGroups = (layer: string): string[] => [`**/${layer}`, `**/${layer}/**`];

/**
 * ADR 0018: vault access is Norn-only. Now that MMR-199 retired the
 * `mkdirSync` deviation, the restricted-import ban the ADR deferred can land:
 * `node:fs` / `node:fs/promises` are banned across the Norn client and the
 * core read/write paths, so the invariant is enforced structurally instead of
 * by review. The ADR's carve-outs — provisioning (`vault/converge.ts`) and
 * version control (`vault/git.ts`, `vault/snapshot.ts`) — live under
 * `vault/**`, a sibling of the banned globs, so they need no explicit
 * exclusion here.
 */
const nodeFsBanPaths = (file: string | undefined): { message: string; name: string }[] => {
  const message = `ADR 0018: vault access is Norn-only — ${file} may not import node:fs directly; read and write vault content through the Norn client.`;
  return [
    { message, name: 'node:fs' },
    { message, name: 'node:fs/promises' },
  ];
};

/**
 * `layers`: layer-boundary group patterns as before (empty to skip). `banFs`:
 * also forbid `node:fs`/`node:fs/promises` on the same files (ADR 0018).
 */
const forbid = (files: string[], layers: string[], options?: { banFs?: boolean }): Override => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        ...(layers.length > 0
          ? {
              patterns: [
                {
                  group: layers.flatMap(layerGroups),
                  message: `Layer boundary: ${files[0]} may not import from ${layers.join(', ')} (contract <- db <- core <- transports).`,
                },
              ],
            }
          : {}),
        ...(options?.banFs === true ? { paths: nodeFsBanPaths(files[0]) } : {}),
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
  forbid(['packages/bin/src/core/**'], ['cli', 'mcp', 'http'], { banFs: true }),
  forbid(['packages/bin/src/cli/**'], ['mcp', 'http']),
  forbid(['packages/bin/src/mcp/**'], ['cli', 'http']),
  forbid(['packages/bin/src/http/**'], ['cli', 'mcp'], { banFs: true }),
  // `norn/**` (the Norn client itself) and `doctor/**` (reaches the vault
  // only via that client already) carry no layer-boundary restriction of
  // their own — just the ADR 0018 node:fs ban. `cli/**` keeps legitimate
  // non-vault filesystem use (the `.mimir.toml` binding file, service
  // config/plist, self-update) that falls outside the ADR's carve-out list,
  // so it is deliberately left unbanned rather than growing carve-outs the
  // ADR doesn't name.
  forbid(['packages/bin/src/norn/**'], [], { banFs: true }),
  forbid(['packages/bin/src/doctor/**'], [], { banFs: true }),
  // Tests legitimately wire layers together (the Norn store fixture from
  // `testing/store`, cross-layer assertions); the boundary constrains shipped
  // code, not tests.
  { files: ['**/*.test.ts'], rules: { 'no-restricted-imports': 'off' } },
  // Tests legitimately force bad/loose types — to drive error paths, assert over
  // untyped HTTP responses, narrow DOM queries — so unsafe assertions are allowed
  // in test files (they own both ends; the safety bar is for shipped code).
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: { 'typescript/no-unsafe-type-assertion': 'off' },
  },
  // The UI's vite config is a Node/Bun build script, not shipped browser code —
  // it reads packages/bin/package.json to stamp the bundle's build version
  // (MMR-260) alongside the binary's own MIMIR_BUILD_VERSION define.
  { files: ['packages/ui/vite.config.ts'], rules: { 'import/no-nodejs-modules': 'off' } },
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
