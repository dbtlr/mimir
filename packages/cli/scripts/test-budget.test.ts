import { describe, expect, test } from 'bun:test';

import { judge, readJunit } from './test-budget';
import type { Budget, Exemption } from './test-budget';

/** A bun junit report: one file with a describe block, one flat file. */
const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" time="9.5">
  <testsuite name="packages/core/src/a.test.ts" file="packages/core/src/a.test.ts" tests="3" time="8.25">
    <testsuite name="Postgres &quot;stores&quot;" file="packages/core/src/a.test.ts" tests="2" time="3.1">
      <testsuite name="nested" file="packages/core/src/a.test.ts" tests="1" time="3">
        <testcase name="round-trips &lt;every&gt; collection" classname="nested" time="3.000" file="packages/core/src/a.test.ts" line="9" />
      </testsuite>
      <testcase name="refuses a stale main" classname="Postgres" time="0.1" file="packages/core/src/a.test.ts" line="4" />
    </testsuite>
    <testcase name="a skipped case" classname="" time="0" file="packages/core/src/a.test.ts" line="20">
      <skipped />
    </testcase>
  </testsuite>
  <testsuite name="packages/wire/src/b.test.ts" file="packages/wire/src/b.test.ts" tests="1" time="1.25">
    <testcase name="it&apos;s quick" classname="" time="1.2" file="packages/wire/src/b.test.ts" line="3" />
  </testsuite>
</testsuites>
`;

const budget: Budget = { fileWarnMs: 5000, testLimitMs: 2000, testWarnMs: 1000 };

describe('readJunit', () => {
  test('names each test by its describe path and unescapes the XML', () => {
    const { tests } = readJunit(report);
    expect(tests.map((t) => [t.file, t.name, t.ms])).toEqual([
      [
        'packages/core/src/a.test.ts',
        'Postgres "stores" > nested > round-trips <every> collection',
        3000,
      ],
      ['packages/core/src/a.test.ts', 'Postgres "stores" > refuses a stale main', 100],
      ['packages/wire/src/b.test.ts', "it's quick", 1200],
    ]);
  });

  test('times each file by its top-level suite and leaves out skipped tests', () => {
    const { files, tests } = readJunit(report);
    expect(files).toEqual([
      { file: 'packages/core/src/a.test.ts', ms: 8250 },
      { file: 'packages/wire/src/b.test.ts', ms: 1250 },
    ]);
    expect(tests.some((t) => t.name === 'a skipped case')).toBe(false);
  });

  test('refuses a document that is not a junit report', () => {
    expect(() => readJunit('<html></html>')).toThrow(/no <testsuite>/);
  });
});

describe('judge', () => {
  const timings = readJunit(report);

  test('a test over the limit fails the budget; one over the warning only warns', () => {
    const verdict = judge(timings, budget, []);
    expect(verdict.over.map((t) => t.name)).toEqual([
      'Postgres "stores" > nested > round-trips <every> collection',
    ]);
    expect(verdict.slow.map((t) => t.name)).toEqual(["it's quick"]);
    expect(verdict.slowFiles.map((f) => f.file)).toEqual(['packages/core/src/a.test.ts']);
  });

  test('an exempt test over the limit warns instead of failing', () => {
    const exemption: Exemption = {
      file: 'packages/core/src/a.test.ts',
      name: 'Postgres "stores" > nested > round-trips <every> collection',
      task: 'MMR-1',
    };
    const verdict = judge(timings, budget, [exemption]);
    expect(verdict.over).toEqual([]);
    expect(verdict.exempt.map((e) => e.exemption.task)).toEqual(['MMR-1']);
    expect(verdict.staleExemptions).toEqual([]);
  });

  test('an exemption whose test runs under the limit, or did not run, is stale', () => {
    const fast: Exemption = {
      file: 'packages/wire/src/b.test.ts',
      name: "it's quick",
      task: 'MMR-2',
    };
    const gone: Exemption = {
      file: 'packages/wire/src/b.test.ts',
      name: 'renamed away',
      task: 'MMR-3',
    };
    const verdict = judge(timings, budget, [fast, gone]);
    expect(verdict.staleExemptions.map((e) => e.task)).toEqual(['MMR-2', 'MMR-3']);
  });
});
