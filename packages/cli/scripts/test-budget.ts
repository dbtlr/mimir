/**
 * Check a `bun test` junit report against the default lane's time budget.
 * CI's gate writes the report while it runs `bun run test`, then runs this.
 * A test over the limit fails the check unless it is exempted below against
 * the task that will make it fast. A test over the warning threshold, or a
 * file over the file threshold, is reported without failing. CONTRIBUTING.md
 * ("Tests that run slow or time out") states the rule. Usage:
 *
 *   bun packages/cli/scripts/test-budget.ts <junit.xml>
 */
import { readFileSync } from 'node:fs';

export type Budget = { testLimitMs: number; testWarnMs: number; fileWarnMs: number };

/**
 * The budget for the Linux gate. The limit leaves headroom under Bun's 5 s
 * default timeout. It also clears the one-off PGlite snapshot boot, about 1.8 s
 * on the gate, which lands on whichever test opens the first Postgres store.
 */
export const BUDGET: Budget = { fileWarnMs: 15_000, testLimitMs: 3000, testWarnMs: 1000 };

/** A test allowed over the limit until its task lands. `name` is the describe path joined with ` > `. */
export type Exemption = { file: string; name: string; task: string };

export const EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'packages/wire/src/host-client.test.ts',
    name: 'a server-cut 401 body remains a definite health refusal',
    task: 'MMR-640',
  },
  {
    file: 'packages/wire/src/host-client.test.ts',
    name: 'a server-cut response body reports an incomplete response before the client timeout',
    task: 'MMR-640',
  },
];

export type TestTiming = { file: string; name: string; ms: number };
export type FileTiming = { file: string; ms: number };
export type Timings = { files: FileTiming[]; tests: TestTiming[] };

const ENTITIES: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };

function unescape(text: string): string {
  return text.replaceAll(/&(amp|apos|gt|lt|quot);/g, (_, entity: string) => ENTITIES[entity] ?? '');
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, key, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (key !== undefined && value !== undefined) {
      found.set(key, unescape(value));
    }
  }
  return found;
}

/**
 * Read the per-test and per-file times from a bun junit report. A file's
 * time is its top-level suite's; a test is named by the describe suites
 * around it. Skipped tests are left out.
 */
export function readJunit(xml: string): Timings {
  const files: FileTiming[] = [];
  const tests: TestTiming[] = [];
  // Open suites from the file inward; index 0 is the file's own suite.
  const suites: string[] = [];
  const tags = xml.matchAll(
    /<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>([\s\S]*?(?=<\/?test(?:suite|case)\b|$))/g,
  );
  for (const [, closing, kind, attrText = '', selfClosing, body = ''] of tags) {
    if (kind === 'testsuite') {
      if (closing) {
        suites.pop();
        continue;
      }
      const attrs = attributes(attrText);
      const name = attrs.get('name') ?? '';
      if (suites.length === 0) {
        files.push({ file: attrs.get('file') ?? name, ms: Number(attrs.get('time') ?? 0) * 1000 });
      }
      suites.push(name);
      continue;
    }
    if (closing) {
      continue;
    }
    const skipped = !selfClosing && /<skipped\b/.test(body);
    if (skipped) {
      continue;
    }
    const attrs = attributes(attrText);
    const name = [...suites.slice(1), attrs.get('name') ?? ''].join(' > ');
    tests.push({
      file: attrs.get('file') ?? suites[0] ?? '',
      ms: Number(attrs.get('time') ?? 0) * 1000,
      name,
    });
  }
  if (files.length === 0) {
    throw new Error('the report has no <testsuite>: is it a junit report?');
  }
  return { files, tests };
}

export type Verdict = {
  /** Tests over the limit with no exemption: these fail the check. */
  over: TestTiming[];
  /** Exempt tests over the limit, with the exemption that covers each. */
  exempt: { test: TestTiming; exemption: Exemption }[];
  /** Tests over the warning threshold and under the limit. */
  slow: TestTiming[];
  slowFiles: FileTiming[];
  /** Exemptions whose test ran under the limit or did not run. */
  staleExemptions: Exemption[];
};

const sameTest = (exemption: Exemption, test: TestTiming) =>
  exemption.file === test.file && exemption.name === test.name;

export function judge(timings: Timings, budget: Budget, exemptions: readonly Exemption[]): Verdict {
  const verdict: Verdict = { exempt: [], over: [], slow: [], slowFiles: [], staleExemptions: [] };
  for (const test of timings.tests) {
    if (test.ms > budget.testLimitMs) {
      const exemption = exemptions.find((candidate) => sameTest(candidate, test));
      if (exemption) {
        verdict.exempt.push({ exemption, test });
      } else {
        verdict.over.push(test);
      }
    } else if (test.ms > budget.testWarnMs) {
      verdict.slow.push(test);
    }
  }
  verdict.slowFiles = timings.files.filter((file) => file.ms > budget.fileWarnMs);
  verdict.staleExemptions = exemptions.filter(
    (exemption) => !verdict.exempt.some((entry) => entry.exemption === exemption),
  );
  for (const list of [verdict.over, verdict.slow, verdict.slowFiles]) {
    list.sort((a, b) => b.ms - a.ms);
  }
  return verdict;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** The report a person reads in the CI log, one line per finding. */
export function describeVerdict(verdict: Verdict, budget: Budget): string {
  const lines: string[] = [];
  for (const test of verdict.over) {
    lines.push(
      `over ${seconds(budget.testLimitMs)}: ${seconds(test.ms)}  ${test.file} > ${test.name}`,
    );
  }
  for (const { test, exemption } of verdict.exempt) {
    lines.push(`exempt (${exemption.task}): ${seconds(test.ms)}  ${test.file} > ${test.name}`);
  }
  for (const test of verdict.slow) {
    lines.push(
      `slow, over ${seconds(budget.testWarnMs)}: ${seconds(test.ms)}  ${test.file} > ${test.name}`,
    );
  }
  for (const file of verdict.slowFiles) {
    lines.push(`slow file, over ${seconds(budget.fileWarnMs)}: ${seconds(file.ms)}  ${file.file}`);
  }
  for (const exemption of verdict.staleExemptions) {
    lines.push(
      `stale exemption (${exemption.task}), under the limit or not run: ${exemption.file} > ${exemption.name}`,
    );
  }
  lines.push(
    verdict.over.length === 0
      ? 'test budget: ok'
      : `test budget: ${verdict.over.length} test(s) over ${seconds(budget.testLimitMs)}. Make them fast; see CONTRIBUTING.md, "Tests that run slow or time out".`,
  );
  return lines.join('\n');
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: bun packages/cli/scripts/test-budget.ts <junit.xml>');
    process.exit(2);
  }
  const verdict = judge(readJunit(readFileSync(path, 'utf8')), BUDGET, EXEMPTIONS);
  console.log(describeVerdict(verdict, BUDGET));
  process.exit(verdict.over.length === 0 ? 0 : 1);
}
