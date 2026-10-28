import { beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The layering rule (ADR 0037): only `src/app.ts` imports `@mimir/core`, so a
 * command reaches work state through the Engine alone. Each case is a probe
 * module written beside the commands, and one lint run through the
 * repository's own lint config reads them all, so the suite pays the linter's
 * startup once and runs only the rule under test.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const probe = (name: string): string =>
  fileURLToPath(
    new URL(`commands/layering-probe-${name}-${String(process.pid)}.ts`, import.meta.url),
  );

const PROBES = {
  contract: { path: probe('contract'), source: "export { MimirError } from '@mimir/contract';\n" },
  core: {
    path: probe('core'),
    source: "import { LocalEngine } from '@mimir/core';\n\nexport { LocalEngine };\n",
  },
  testing: {
    path: probe('testing'),
    source: "export { parityBoard } from '../testing/fixture';\n",
  },
  typed: { path: probe('typed'), source: "export const count: number = 'one';\n" },
  wire: {
    path: probe('wire'),
    source: "export { RemoteEngine } from '@mimir/wire/client';\n",
  },
};
const APP = fileURLToPath(new URL('app.ts', import.meta.url));

/** Each linted file's diagnostic messages and help, keyed by its absolute path. */
let findings: Map<string, string>;

type Diagnostic = { filename: string; help?: string; message: string };

/**
 * A report's file name as an absolute path. The linter may name a file
 * relative to the repository, absolutely, or as a `file://` URL.
 */
const absolute = (filename: string): string =>
  filename.startsWith('file:') ? fileURLToPath(filename) : resolve(repository, filename);

/**
 * Lint the files with only the layering rule on (its per-file options and
 * messages still come from the repository config) and without type
 * information, then group the diagnostics by file. The rule reads import
 * specifiers alone, and the type program it would otherwise build can take
 * seconds on a cold CI runner. The JSON format reads the same on a terminal,
 * under CI, and under GitHub Actions, where the default format turns
 * graphical or into annotations that drop the rule's custom help.
 */
function lint(paths: readonly string[]): Map<string, string> {
  const args = ['x', 'vp', 'lint', '--format', 'json', '-A', 'all', '-D', 'no-restricted-imports'];
  const run = spawnSync('bun', [...args, ...paths], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, MIMIR_LINT_TYPE_AWARE: '0' },
  });
  let report: { diagnostics?: unknown } | undefined;
  try {
    report = JSON.parse(run.stdout) as { diagnostics?: unknown };
  } catch {
    // Reported below with the linter's own output.
  }
  if (!Array.isArray(report?.diagnostics)) {
    throw new TypeError(`vp lint wrote no JSON report:\n${run.stdout}${run.stderr}`);
  }
  const grouped = new Map<string, string>();
  for (const { filename, help = '', message } of report.diagnostics as Diagnostic[]) {
    const key = absolute(filename);
    grouped.set(key, `${grouped.get(key) ?? ''}${message}\n${help}\n`);
  }
  return grouped;
}

const of = (path: string): string => findings.get(resolve(path)) ?? '';

beforeAll(() => {
  // The probes break the repository's own lint run, so none outlives this hook.
  try {
    for (const { path, source } of Object.values(PROBES)) {
      writeFileSync(path, source);
    }
    findings = lint([...Object.values(PROBES).map(({ path }) => path), APP]);
  } finally {
    for (const { path } of Object.values(PROBES)) {
      rmSync(path, { force: true });
    }
  }
});

test('a command module that imports @mimir/core is refused', () => {
  expect(of(PROBES.core.path)).toContain('only packages/cli/src/app.ts imports @mimir/core');
});

test('a command module that imports the wire is refused', () => {
  expect(of(PROBES.wire.path)).toContain('only packages/cli/src/app.ts imports @mimir/wire');
});

test('a command module that imports the test-support helpers is refused', () => {
  expect(of(PROBES.testing.path)).toContain('only tests import packages/cli/src/testing');
});

test('the lint run reports no type errors, so it runs without type information', () => {
  expect(of(PROBES.typed.path)).toBe('');
});

test('the composition root imports core, and a command the contract, cleanly', () => {
  expect(of(PROBES.contract.path)).toBe('');
  expect(of(APP)).toBe('');
});
