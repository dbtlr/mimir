import { beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The primitives rule (ADR 0046): only `src/components/ui` imports
 * `@ui-sdk/*`. Each case is a probe module written into the console's source
 * tree, and one lint run through the repository's own lint config reads them
 * all, so the suite pays the linter's startup once and runs only the rule
 * under test.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const source = (relative: string): string =>
  fileURLToPath(new URL(`../src/${relative}`, import.meta.url));
const pid = String(process.pid);

const IMPORT = "import { Dialog } from '@ui-sdk/react/dialog';\n\nexport { Dialog };\n";
const PROBES = {
  feature: { path: source(`components/ui-sdk-probe-feature-${pid}.tsx`), source: IMPORT },
  primitive: { path: source(`components/ui/ui-sdk-probe-primitive-${pid}.tsx`), source: IMPORT },
  primitiveTest: {
    path: source(`components/ui/ui-sdk-probe-${pid}.test.ts`),
    source: IMPORT,
  },
  route: { path: source(`routes/ui-sdk-probe-route-${pid}.tsx`), source: IMPORT },
  serverFn: { path: source(`api/fns/ui-sdk-probe-fn-${pid}.ts`), source: IMPORT },
  test: { path: source(`components/ui-sdk-probe-${pid}.test.ts`), source: IMPORT },
  vendored: {
    path: source(`components/ui-sdk-probe-vendored-${pid}.tsx`),
    source: "export { Dialog } from '../../node_modules/@ui-sdk/react/dist/dialog.js';\n",
  },
};

type Diagnostic = { filename: string; help?: string; message: string };

/** Each linted file's diagnostic messages and help, keyed by its absolute path. */
let findings: Map<string, string>;

/** A report's file name as an absolute path: relative, absolute, or a `file://` URL. */
const absolute = (filename: string): string =>
  filename.startsWith('file:') ? fileURLToPath(filename) : resolve(repository, filename);

/**
 * Lint the files with only the import rule on (its per-file options and
 * messages still come from the repository config) and without type
 * information, then group the diagnostics by file.
 */
function lint(paths: readonly string[]): Map<string, string> {
  const args = ['lint', '--format', 'json', '-A', 'all', '-D', 'no-restricted-imports'];
  const run = spawnSync(resolve(repository, 'node_modules/.bin/vp'), [...args, ...paths], {
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
    for (const probe of Object.values(PROBES)) {
      writeFileSync(probe.path, probe.source);
    }
    findings = lint(Object.values(PROBES).map(({ path }) => path));
  } finally {
    for (const { path } of Object.values(PROBES)) {
      rmSync(path, { force: true });
    }
  }
});

const REFUSAL = 'only packages/host/src/components/ui imports @ui-sdk/*';

test('a feature component that imports UI SDK is refused', () => {
  expect(of(PROBES.feature.path)).toContain(REFUSAL);
});

test('a route that imports UI SDK is refused', () => {
  expect(of(PROBES.route.path)).toContain(REFUSAL);
});

test('a server function that imports UI SDK is refused', () => {
  expect(of(PROBES.serverFn.path)).toContain(REFUSAL);
});

test('a console test outside components/ui that imports UI SDK is refused', () => {
  expect(of(PROBES.test.path)).toContain(REFUSAL);
});

test('a relative path into node_modules/@ui-sdk is refused', () => {
  expect(of(PROBES.vendored.path)).toContain(REFUSAL);
});

test('a primitive in components/ui imports UI SDK cleanly', () => {
  expect(of(PROBES.primitive.path)).toBe('');
});

test('a test beside the primitives imports UI SDK cleanly', () => {
  expect(of(PROBES.primitiveTest.path)).toBe('');
});
