import { describe, expect, test } from 'bun:test';

import { judge, passes, readJunit, run } from './test-budget';
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
    expect(verdict.unusedExemptions).toEqual([]);
    expect(passes(verdict)).toBe(true);
  });

  test('an exemption whose test ran under the limit only warns, since runner speed varies', () => {
    const fast: Exemption = {
      file: 'packages/wire/src/b.test.ts',
      name: "it's quick",
      task: 'MMR-2',
    };
    const verdict = judge(timings, budget, [fast]);
    expect(verdict.unusedExemptions.map((e) => e.task)).toEqual(['MMR-2']);
    expect(verdict.missingExemptions).toEqual([]);
  });

  test('an exemption whose test did not run fails, so a renamed test cannot leave it behind', () => {
    const gone: Exemption = {
      file: 'packages/wire/src/b.test.ts',
      name: 'renamed away',
      task: 'MMR-3',
    };
    // The fixture's one slow test is exempt, so the missing exemption is the only failure.
    const slow: Exemption = {
      file: 'packages/core/src/a.test.ts',
      name: 'Postgres "stores" > nested > round-trips <every> collection',
      task: 'MMR-1',
    };
    const verdict = judge(timings, budget, [slow, gone]);
    expect(verdict.over).toEqual([]);
    expect(verdict.missingExemptions.map((e) => e.task)).toEqual(['MMR-3']);
    expect(passes(verdict)).toBe(false);
  });

  test('a test over the limit fails the budget', () => {
    expect(passes(judge(timings, budget, []))).toBe(false);
  });

  test('a test or file exactly at a threshold is within it', () => {
    const verdict = judge(
      {
        files: [{ file: 'f.test.ts', ms: budget.fileWarnMs }],
        tests: [
          { file: 'f.test.ts', ms: budget.testLimitMs, name: 'at the limit' },
          { file: 'f.test.ts', ms: budget.testWarnMs, name: 'at the warning' },
        ],
      },
      budget,
      [],
    );
    expect(verdict.over.map((t) => t.name)).toEqual([]);
    expect(verdict.slow.map((t) => t.name)).toEqual(['at the limit']);
    expect(verdict.slowFiles).toEqual([]);
  });

  test('an exemption covers a test only when both its file and its name match', () => {
    const slow = 'Postgres "stores" > nested > round-trips <every> collection';
    const otherFile: Exemption = { file: 'packages/wire/src/b.test.ts', name: slow, task: 'MMR-4' };
    const otherName: Exemption = {
      file: 'packages/core/src/a.test.ts',
      name: 'Postgres "stores" > refuses a stale main',
      task: 'MMR-5',
    };
    const verdict = judge(timings, budget, [otherFile, otherName]);
    expect(verdict.over.map((t) => t.name)).toEqual([slow]);
    expect(verdict.exempt).toEqual([]);
  });
});

describe('readJunit, on the rest of what bun writes', () => {
  const failing = `<testsuites>
  <testsuite name="f.test.ts" file="f.test.ts" time="2">
    <testcase name="a &amp; b, line&#10;two, &#x41;" classname="" time="1.5" file="f.test.ts" line="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>`;

  test('a failing test, written with a body, is timed like any other', () => {
    expect(readJunit(failing).tests.map((t) => t.ms)).toEqual([1500]);
  });

  test('named and numeric character references are decoded', () => {
    expect(readJunit(failing).tests.map((t) => t.name)).toEqual(['a & b, line\ntwo, A']);
  });
});

/** A terminal over in-memory reports that records what it prints. */
function io(reports: Record<string, string>) {
  const out: string[] = [];
  return {
    error: (line: string) => out.push(line),
    log: (line: string) => out.push(line),
    out,
    readFile: (path: string) => reports[path] ?? '',
  };
}

describe('run', () => {
  test('exits 1 when the report is over budget and 0 when it is within it', () => {
    const within = report.replaceAll('time="3.000"', 'time="0.5"');
    expect(run(['over.xml'], io({ 'over.xml': report }), budget, [])).toBe(1);
    expect(run(['within.xml'], io({ 'within.xml': within }), budget, [])).toBe(0);
  });

  test('exits 2 with its usage when no report is named', () => {
    const terminal = io({});
    expect(run([], terminal, budget, [])).toBe(2);
    expect(terminal.out.join('\n')).toContain('usage:');
  });
});
