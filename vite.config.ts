import { defineConfig, toolingPlugin } from '@dbtlr/tooling';
import type { LintOverride } from '@dbtlr/tooling';

type Override = LintOverride;

/**
 * Centralized monorepo lint config (@dbtlr/tooling).
 *
 * The Bun `workspaces` array in package.json marks this tree a monorepo, so
 * vite-plus centralizes lint/fmt here — per-package `lint` blocks are ignored
 * (only Vite/Vitest/build config is honored per package). `toolingConfig`'s
 * `node`/`react` take glob lists to scope each target to its package:
 *   - `packages/bin/**` is the Bun binary (CLI/MCP/HTTP transports) and
 *     `packages/core/**` is the domain core it builds on — `node` is the
 *     closest shipped target (allows `node:` builtins). NOTE: there is no
 *     `bun` target yet, so `bun:*` imports and the `Bun` global are not covered.
 *   - `packages/contract/**` and `packages/wire/**` use the browser baseline.
 *
 * The React SPA (`packages/host`) does NOT use toolingConfig's `react` target.
 * That target enables react/react-perf/jsx-a11y as a bundle and activates their
 * rules via the `perf`/`correctness` categories; because vite-plus orders the
 * target's override last, a consumer cannot turn individual rules back off from
 * `lint.overrides`. So we replicate the target by hand in `uiLintOverride` —
 * same plugins, but we own the rule severities (quarantine the noisy ones,
 * keep correctness like rules-of-hooks). Re-enable one at a time there.
 *
 * Layer-boundary enforcement (the one thing toolingConfig can't express) rides
 * through `lint.overrides`. The flow is `contract ← @mimir/core ← @mimir/bin`,
 * and `@mimir/cli` (the Loom CLI) imports core only in its composition root,
 * `src/app.ts`, and never imports bin outside its tests:
 *   - The console's server functions (`packages/host/src/api/fns/**`) call the
 *     host's Engine only — no core and no host runtime
 *     except in `fns/engine.ts`, which opens it (ADR 0034).
 *   - `@mimir/core` (`packages/core`) never imports `@mimir/bin`, tests included.
 *   - `@mimir/bin` reaches core only through its entries, `@mimir/core` and
 *     `@mimir/core/testing` — never a deep path.
 *   - Inside bin, transports (cli, mcp) never import each other.
 *     `main.ts` is the composition root and is intentionally unrestricted
 *     among transports.
 *
 * Patterns match the relative import specifiers we actually write (`../cli/x`,
 * `../../bin/y`); `**` spans the leading `..` segments. Brace/extglob `@(...)`
 * forms are avoided — oxlint silently ignores them in `overrides[].files`.
 */
const layerGroups = (layer: string): string[] => [`**/${layer}`, `**/${layer}/**`];

/** The only paths into core a bin file may import: its two entries. */
const coreEntryOnly = {
  group: ['@mimir/core/*', '!@mimir/core/testing', '**/core/src', '**/core/src/**'],
  message: 'Layer boundary: bin reaches core only through @mimir/core or @mimir/core/testing.',
};

/** Core never reaches up into bin, by package name or by relative path. */
const noBinImports = {
  group: ['@mimir/bin', '@mimir/bin/**', '**/bin', '**/bin/**'],
  message: 'Layer boundary: @mimir/core may not import from @mimir/bin (contract <- core <- bin).',
};

const noWireImports = {
  group: ['@mimir/wire', '@mimir/wire/**', '**/wire/src', '**/wire/src/**'],
  message: 'Layer boundary: contract and core may not import the wire transport.',
};

/** The Loom CLI's commands reach work state through the Engine alone: no core import. */
const cliNoCore = {
  group: ['@mimir/core', '@mimir/core/*', '**/core/src', '**/core/src/**'],
  message:
    'Layer boundary: only packages/cli/src/app.ts imports @mimir/core; commands reach work state through the Engine.',
};

/** The Loom CLI's commands reach a host through the Engine too: the composition root picks the wire. */
const cliNoWire = {
  group: ['@mimir/wire', '@mimir/wire/**', '**/wire/src', '**/wire/src/**'],
  message:
    'Layer boundary: only packages/cli/src/app.ts imports @mimir/wire; commands reach work state through the Engine.',
};

/** The Loom CLI replaces the old binary and never builds on it, tests and test support included. */
const cliNoBin = {
  group: ['@mimir/bin', '@mimir/bin/**', '**/bin/src', '**/bin/src/**'],
  message: 'Layer boundary: @mimir/cli may not import @mimir/bin.',
};

/**
 * The CLI's test-support modules build stores, so the shipped modules may not
 * import them: they would reach core around the Engine.
 */
const cliNoTesting = {
  group: ['**/testing', '**/testing/**'],
  message: 'Layer boundary: only tests import packages/cli/src/testing; it reaches core.',
};

const noCoreImports = {
  group: ['@mimir/core', '@mimir/core/**', '**/core', '**/core/**'],
  message: 'Layer boundary: contract and wire depend on the Engine contract, not core.',
};

/**
 * What a server-function module may not import: core, and (unless it is the
 * one Engine opener) the host runtime and store owner.
 */
const serverFnBoundary = (closeRuntime: boolean) => ({
  group: [
    '@mimir/core',
    '@mimir/core/**',
    '**/core/src/**',
    ...(closeRuntime ? ['**/server/runtime', '**/server/host'] : []),
  ],
  message:
    'Layer boundary: server functions call Engine methods through fns/engine.ts, never core or the host runtime (ADR 0034 decision 7).',
});

/** Restrict `files` to the given import `patterns`. */
const restrict = (files: string[], patterns: object[]): Override => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

/** Forbid `files` from importing the transport `layers` given, and core's internals. */
const forbid = (files: string[], layers: string[]): Override =>
  restrict(files, [
    {
      group: layers.flatMap(layerGroups),
      message: `Layer boundary: ${files[0]} may not import from ${layers.join(', ')} (transports never import each other).`,
    },
    coreEntryOnly,
  ]);

/**
 * Conformance backlog — @dbtlr/tooling's rules are best practices we adopt.
 * Everything auto-fixable has already been conformed (`vp lint --fix`); these
 * are the non-auto-fixable residual, disabled to keep `vp check` green while we
 * WALK THEM DOWN ONE AT A TIME: remove a line, fix the code (inline-disable only
 * the true exceptions), commit, repeat. Counts are at the time of capture.
 */
const quarantinedRules: Record<string, 'off'> = {
  'no-await-in-loop': 'off', // 57 — many are intentional sequential I/O
  'unicorn/max-nested-calls': 'off', // nested renderer/composition expressions remain readable
  // contradicts vitest/prefer-called-once (which we keep) — opposite preferences,
  // both on by default; can't satisfy both, so this twin stays off.
  'vitest/prefer-called-times': 'off',
};

/**
 * Deliberate style opt-outs, not backlog. oxlint 1.85 moved `one-var` into the
 * `style` category; its default demands one combined declaration per scope,
 * which no code here follows (6,237 hits). It belongs beside @dbtlr/tooling's
 * relaxed defaults (TLG-s1); drop it here once the shared config turns it off.
 */
const styleOptOuts: Record<string, 'off'> = {
  'one-var': 'off',
};

/**
 * Hand-rolled replacement for toolingConfig's `react` target (see header). Same
 * plugin bundle, but we own the severities: replicate the target's own opt-outs,
 * keep react correctness (rules-of-hooks etc.) live, and quarantine the noisy
 * react-perf / jsx-a11y / react-style rules. Re-enable one at a time here.
 */
const uiLintOverride: Override = {
  files: ['packages/host/**'],
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
    'react/function-component-definition': 'off',
    'react/hook-use-state': 'off', // 1
    'react/jsx-max-depth': 'off',
    'react/jsx-props-no-spreading': 'off',
    'react/react-in-jsx-scope': 'off', // React 19 jsx-runtime — no import needed
    'unicorn/filename-case': 'off',
  },
};

const layerOverrides: Override[] = [
  restrict(['packages/contract/**', 'packages/wire/**'], [noBinImports, noCoreImports]),
  restrict(
    ['packages/wire/src/client.ts'],
    [
      noBinImports,
      noCoreImports,
      {
        allowTypeImports: true,
        group: ['./server', '@mimir/wire/server', '@trpc/server', '@trpc/server/**'],
        message: 'Layer boundary: the remote client imports server types only.',
      },
    ],
  ),
  restrict(['packages/bin/**'], [coreEntryOnly]),
  restrict(['packages/host/**'], [noBinImports, coreEntryOnly]),
  // The console's server functions reach the domain only through the host's
  // Engine (ADR 0034 decision 7): never core or the host
  // runtime that holds them. Only fns/engine.ts opens the runtime, and it
  // hands the rest the `Engine` interface.
  restrict(['packages/host/src/api/fns/**'], [noBinImports, serverFnBoundary(true)]),
  restrict(['packages/host/src/api/fns/engine.ts'], [noBinImports, serverFnBoundary(false)]),
  forbid(['packages/bin/src/cli/**'], ['mcp']),
  forbid(['packages/bin/src/mcp/**'], ['cli']),
  restrict(['packages/cli/**'], [cliNoCore, cliNoWire, cliNoBin, cliNoTesting]),
  restrict(['packages/cli/src/app.ts'], [cliNoBin, cliNoTesting, coreEntryOnly]),
  // Tests legitimately wire layers together (the store fixture from
  // `testing/store`, cross-layer assertions); the boundary constrains shipped
  // code, not tests.
  { files: ['**/*.test.ts'], rules: { 'no-restricted-imports': 'off' } },
  // The core/bin direction holds for tests too: core tests may not import bin,
  // and bin tests still reach core only through its entries.
  restrict(['packages/core/**'], [noBinImports, noWireImports]),
  restrict(['packages/contract/**'], [noBinImports, noCoreImports, noWireImports]),
  restrict(['packages/wire/**/*.test.ts'], [coreEntryOnly, noBinImports]),
  restrict(['packages/bin/**/*.test.ts'], [coreEntryOnly]),
  // The CLI's tests and test-support modules build stores for the parity cases;
  // they still reach core only through its entries, and never the old binary.
  // Shipped CLI modules may not import them (cliNoTesting above).
  restrict(['packages/cli/**/*.test.ts', 'packages/cli/src/testing/**'], [coreEntryOnly, cliNoBin]),
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
  { files: ['packages/host/vite.config.ts'], rules: { 'import/no-nodejs-modules': 'off' } },
  // Playwright/build fixtures execute under Bun and own isolated temporary
  // directories; they are not part of the browser bundle.
  {
    files: [
      'packages/host/e2e/**',
      'packages/host/playwright.config.ts',
      'packages/host/scripts/**',
    ],
    rules: {
      'import/no-nodejs-modules': 'off',
      'promise/avoid-new': 'off',
      'vitest/consistent-test-filename': 'off',
    },
  },
  uiLintOverride,
];

export default defineConfig({
  lint: {
    jsPlugins: ['@loomcli/eslint-plugin'],
    overrides: [
      {
        files: ['packages/cli/**', 'packages/host/src/admin/**', 'packages/sandbox/**'],
        rules: {
          '@loomcli/discarded-declaration': 'error',
          '@loomcli/name-shape': 'error',
          '@loomcli/undescribed': 'error',
        },
      },
      {
        // The sandbox is the repo's own process supervisor (it spawns and signals the
        // programs it tests), and test support builds the real folders a mock gets handed.
        excludeFiles: ['packages/cli/src/testing/**', 'packages/host/src/admin/testing.ts'],
        files: ['packages/cli/**', 'packages/host/src/admin/**'],
        rules: { '@loomcli/host-bypass': 'error' },
      },
    ],
  },
  plugins: [
    toolingPlugin({
      fmt: {
        // Machine-written route trees and build output.
        ignores: ['**/routeTree.gen.ts', '**/.output/**'],
      },
      lint: {
        ignores: ['dist/**', '**/routeTree.gen.ts', '**/.output/**'],
        overrides: layerOverrides,
        rules: { ...quarantinedRules, ...styleOptOuts },
        // MIMIR_LINT_TYPE_AWARE=0 lints without type information (and so
        // without type checking). The CLI layering test sets it: its import
        // rule needs no types, and building the type program on a cold CI
        // runner can take seconds (MMR-572).
        typeAware: process.env.MIMIR_LINT_TYPE_AWARE !== '0',
      },
      node: {
        files: [
          'packages/bin/**',
          'packages/cli/**',
          'packages/core/**',
          'packages/sandbox/**',
          'packages/host/src/server/**',
          'packages/host/src/admin/**',
        ],
        // Synchronous filesystem access is deliberate in this local-first CLI.
        rules: { 'node/no-sync': 'off' },
      },
    }),
  ],
});
