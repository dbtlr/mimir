import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
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
  bin: { path: probe('bin'), source: "export { runCli } from '@mimir/bin/src/cli';\n" },
  contract: { path: probe('contract'), source: "export { MimirError } from '@mimir/contract';\n" },
  core: {
    path: probe('core'),
    source: "import { LocalEngine } from '@mimir/core';\n\nexport { LocalEngine };\n",
  },
  testing: {
    path: probe('testing'),
    source: "export { parityBoard } from '../testing/fixture';\n",
  },
};
const APP = fileURLToPath(new URL('app.ts', import.meta.url));

/** Each linted file's diagnostic messages and help, keyed by the path relative to the repository. */
let findings: Map<string, string>;

type Diagnostic = { filename: string; help?: string; message: string };

/**
 * Lint the files with only the layering rule on (its per-file options and
 * messages still come from the repository config) and group the diagnostics
 * by file. The JSON format reads the same on a terminal, under CI, and under
 * GitHub Actions, where the default format turns graphical or into
 * annotations that drop the rule's custom help.
 */
function lint(paths: readonly string[]): Map<string, string> {
  const args = ['x', 'vp', 'lint', '--format', 'json', '-A', 'all', '-D', 'no-restricted-imports'];
  const run = spawnSync('bun', [...args, ...paths], { cwd: repository, encoding: 'utf8' });
  let diagnostics: Diagnostic[];
  try {
    ({ diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] });
  } catch {
    throw new Error(`vp lint wrote no JSON report:\n${run.stdout}${run.stderr}`);
  }
  const grouped = new Map<string, string>();
  for (const { filename, help = '', message } of diagnostics) {
    grouped.set(filename, `${grouped.get(filename) ?? ''}${message}\n${help}\n`);
  }
  return grouped;
}

const of = (path: string): string => findings.get(path.slice(repository.length)) ?? '';

beforeAll(() => {
  for (const { path, source } of Object.values(PROBES)) {
    writeFileSync(path, source);
  }
  findings = lint([...Object.values(PROBES).map(({ path }) => path), APP]);
});

afterAll(() => {
  for (const { path } of Object.values(PROBES)) {
    rmSync(path, { force: true });
  }
});

test('a command module that imports @mimir/core is refused', () => {
  expect(of(PROBES.core.path)).toContain('only packages/cli/src/app.ts imports @mimir/core');
});

test('a command module that imports the old binary is refused', () => {
  expect(of(PROBES.bin.path)).toContain('@mimir/cli may not import @mimir/bin');
});

test('a command module that imports the test-support helpers is refused', () => {
  expect(of(PROBES.testing.path)).toContain('only tests import packages/cli/src/testing');
});

test('the composition root imports core, and a command the contract, cleanly', () => {
  expect(of(PROBES.contract.path)).toBe('');
  expect(of(APP)).toBe('');
});
