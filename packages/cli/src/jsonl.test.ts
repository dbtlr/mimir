import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import { freezeClock } from './testing/clock';
import { parityBoard } from './testing/fixture';
import type { ParityBoard } from './testing/fixture';
import { runNew } from './testing/parity';
import type { ParityCase, ParityRun } from './testing/parity';

/**
 * The `jsonl` view against the `json` view of the same command (ADR 0037). A
 * command that answers with one document prints it as `jsonl` too: status and
 * overview as its compact form on a single line, which the old CLI printed as
 * styled text, and get as the same indented document. A command that answers
 * with a list prints each record as a line, and every line is the compact form
 * of a record in the `json` document. The cases run on the shared fixture board.
 */
type Relation = 'compact' | 'same' | 'records';

type Sample = {
  path: readonly string[];
  args?: Readonly<Record<string, string>>;
  options?: Readonly<Record<string, string>>;
  relation: Relation;
  /** For `records`: the array of the json document that jsonl serializes, one line per element. */
  records?: string;
};

const SAMPLES: readonly Sample[] = [
  { args: { id: 'MMR-3' }, path: ['status'], relation: 'compact' },
  { options: { scope: 'MMR' }, path: ['overview'], relation: 'compact' },
  { args: { id: 'MMR' }, path: ['tree'], relation: 'compact' },
  { args: { id: 'MMR-3' }, path: ['get'], relation: 'same' },
  { options: { scope: 'MMR' }, path: ['next'], records: 'tasks', relation: 'records' },
  { options: { scope: 'MMR' }, path: ['list'], records: 'tasks', relation: 'records' },
  { path: ['projects'], records: 'projects', relation: 'records' },
  { options: { scope: 'MMR' }, path: ['artifacts'], records: 'artifacts', relation: 'records' },
  {
    args: { query: 'store' },
    options: { scope: 'MMR' },
    path: ['search'],
    records: 'results',
    relation: 'records',
  },
  { options: { project: 'MMR' }, path: ['seeds'], records: 'seeds', relation: 'records' },
  {
    options: { scope: 'MMR' },
    path: ['scratch', 'list'],
    records: 'scratchpads',
    relation: 'records',
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

let board: ParityBoard;
beforeAll(async () => {
  freezeClock(true);
  board = await parityBoard();
  await board.engine.scratchCreate({ project: 'MMR', title: 'Blank' });
});
afterAll(async () => {
  await board.close();
  freezeClock(false);
});

const nameOf = (sample: Sample): string => sample.path.join(' ');

/** A sample run under one format. */
const under = (sample: Sample, format: string): Promise<ParityRun> => {
  const c: ParityCase = {
    ...(sample.args === undefined ? {} : { args: sample.args }),
    name: nameOf(sample),
    options: { ...sample.options, format },
    path: sample.path,
  };
  return runNew((argv) => board.app('MMR', argv), c);
};

test('every sampled command declares both views, and status and overview print compact lines', () => {
  const declared: string[] = [];
  const visit = (
    node: ReturnType<ReturnType<typeof board.app>['inspect']>['root'],
    path: string[],
  ): void => {
    const views = node.result?.views ?? [];
    if (
      views.includes('json') &&
      views.includes('jsonl') &&
      SAMPLES.some((s) => s.path.join(' ') === path.join(' '))
    ) {
      declared.push(path.join(' '));
    }
    for (const child of node.children) {
      visit(child, [...path, child.name ?? '']);
    }
  };
  visit(board.app().inspect().root, []);
  expect(declared.toSorted()).toEqual(SAMPLES.map(nameOf).toSorted());
  expect(SAMPLES.filter((s) => s.relation === 'compact').map(nameOf)).toEqual(
    expect.arrayContaining(['status', 'overview']),
  );
});

test.each(SAMPLES)('$path jsonl relates to its json document as $relation', async (sample) => {
  const json = await under(sample, 'json');
  const jsonl = await under(sample, 'jsonl');
  expect([json.exitCode, jsonl.exitCode]).toEqual([0, 0]);
  const document = parseJson(json.stdout);
  if (sample.relation === 'same') {
    expect(jsonl.stdout).toBe(json.stdout);
  } else if (sample.relation === 'compact') {
    expect(jsonl.stdout).toBe(`${JSON.stringify(document)}\n`);
  } else {
    const array = isRecord(document) ? document[sample.records ?? ''] : undefined;
    expect(Array.isArray(array)).toBe(true);
    const lines = jsonl.stdout.split('\n').filter((line) => line !== '');
    // Every element, once, in order: a dropped, repeated, or reordered row fails.
    expect(lines).toEqual((array as unknown[]).map((record) => JSON.stringify(record)));
    expect(lines.length).toBeGreaterThan(0);
  }
});
