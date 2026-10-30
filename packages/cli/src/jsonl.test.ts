import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJson } from '@mimir/helpers';

import { argvCase } from './testing/argv-case';
import { FROZEN_AT } from './testing/clock';
import type { ParityBoard } from './testing/fixture';
import { runNew } from './testing/parity';
import type { ParityRun } from './testing/parity';
import { bindCase, openBoard } from './testing/writes';

/**
 * The `jsonl` view against the `json` view of the same command (ADR 0037), for
 * every command that declares a `jsonl` view, writes included. A command that
 * answers with a list prints each record as a line, and every line is the
 * compact form of a record in the `json` document. A command that answers with
 * one document prints it in one of two ways: status, overview, tree, triage,
 * and the Scratchpad commands as its compact form on a single line; every
 * other one, get and the writes that answer with a node or a receipt, as the
 * same indented document `json` prints. That second form is the old CLI's
 * `jsonl` bytes, which ADR 0037 keeps unchanged, so a change to it is a change
 * of contract and not a fix here. Each sample runs on its own fresh board per
 * format, both boards built the same way; the random Scratchpad ids read as
 * `<uuid>`, since they differ between the two boards by design.
 */
type Relation = 'compact' | 'same' | 'records';

type Sample = {
  /** The argv, without a format. `{token}` names a board's record, `{dir}` its scratch directory. */
  words: readonly string[];
  relation: Relation;
  /** For `records`: the array of the json document that jsonl serializes; absent when the document is the array. */
  records?: string;
  /** Moves the board to the state the command acts on, before it runs. */
  before?: (board: ParityBoard) => Promise<unknown> | void;
};

/** A finding doctor reports, so its findings-only `jsonl` prints a line. */
const FINDING = {
  check: 'orphan-edge',
  code: 'orphan-edge',
  evidence: {},
  locator: 'edge/7',
  message: 'MMR-2 depends on a node that is gone',
  node: 'MMR-2',
  scopeKey: 'MMR',
  severity: 'warn',
  stem: 'MMR-2',
  where: 'edge · to_id',
} as const;

const GUARD = ['--expected-updated-at', '{token}'];

/** One sample per command, keyed by its path. */
const SAMPLES: Readonly<Record<string, Sample>> = {
  abandon: { relation: 'same', words: ['abandon', 'MMR-3', 'dropped'] },
  annotate: { relation: 'same', words: ['annotate', 'MMR-3', 'a note'] },
  archive: { relation: 'same', words: ['archive', 'XX'] },
  artifacts: { records: 'artifacts', relation: 'records', words: ['artifacts', '-s', 'MMR'] },
  attach: {
    before: (board) => writeFileSync(join(board.dir, 'notes.md'), '# Notes\n\nThe body.\n'),
    relation: 'same',
    words: ['attach', 'MMR-5', '--file', '{dir}/notes.md'],
  },
  bind: { relation: 'same', words: ['bind', 'MMR'] },
  block: { relation: 'same', words: ['block', 'MMR-3', 'upstream down'] },
  'create initiative': {
    relation: 'same',
    words: ['create', 'initiative', 'Growth', '--parent', 'MMR'],
  },
  'create phase': { relation: 'same', words: ['create', 'phase', 'Next', '--parent', 'MMR-1'] },
  'create project': {
    relation: 'same',
    words: ['create', 'project', 'New', '--key', 'NEW', '--yes'],
  },
  'create task': { relation: 'same', words: ['create', 'task', 'Thing', '--parent', 'MMR-2'] },
  depend: { relation: 'same', words: ['depend', 'MMR-5', '--on', 'MMR-3'] },
  doctor: {
    before: (board) => {
      board.findings.push(FINDING);
    },
    relation: 'records',
    words: ['doctor', '-s', 'MMR'],
  },
  done: { relation: 'same', words: ['done', 'MMR-5'] },
  get: { relation: 'same', words: ['get', 'MMR-3'] },
  groom: { relation: 'same', words: ['groom', 'MMR-4', 'groomed'] },
  list: { records: 'tasks', relation: 'records', words: ['list', '-s', 'MMR'] },
  move: { relation: 'same', words: ['move', 'MMR-5', '--to', 'MMR-1'] },
  next: { records: 'tasks', relation: 'records', words: ['next', '-s', 'MMR'] },
  overview: { relation: 'compact', words: ['overview', '-s', 'MMR'] },
  park: { relation: 'same', words: ['park', 'MMR-3', 'later'] },
  projects: { records: 'projects', relation: 'records', words: ['projects'] },
  promote: { relation: 'same', words: ['promote', 'MMR-s1', '--parent', 'MMR-2'] },
  queue: { relation: 'same', words: ['queue', 'MMR-3', '--session', 'run-1'] },
  reject: { relation: 'same', words: ['reject', 'MMR-s1', 'no'] },
  reopen: { relation: 'same', words: ['reopen', 'MMR-7'] },
  reorder: { relation: 'same', words: ['reorder', 'MMR-3', '--bottom'] },
  resolve: { relation: 'same', words: ['resolve', 'MMR-s1', 'done'] },
  return: {
    before: (board) => board.engine.submit({ id: 'MMR-5' }),
    relation: 'same',
    words: ['return', 'MMR-5'],
  },
  'scratch agenda': {
    relation: 'compact',
    words: ['scratch', 'agenda', 'add', '{pad}', 'item', ...GUARD],
  },
  'scratch checkpoint': {
    relation: 'compact',
    words: ['scratch', 'checkpoint', '{pad}', 'note', ...GUARD],
  },
  'scratch create': { relation: 'compact', words: ['scratch', 'create', 'Index', '-s', 'MMR'] },
  'scratch discard': {
    relation: 'compact',
    // The blank pad was never written after its creation, so its guard is the frozen instant.
    words: ['scratch', 'discard', '{blank}', '--expected-updated-at', FROZEN_AT.toISOString()],
  },
  'scratch freeze': {
    relation: 'same',
    words: ['scratch', 'freeze', '{pad}', '--summary', 's', ...GUARD],
  },
  'scratch get': { relation: 'compact', words: ['scratch', 'get', '{pad}'] },
  'scratch list': {
    records: 'scratchpads',
    relation: 'records',
    words: ['scratch', 'list', '-s', 'MMR'],
  },
  'scratch update': {
    relation: 'compact',
    words: ['scratch', 'update', '{pad}', '--title', 'T', ...GUARD],
  },
  search: { records: 'results', relation: 'records', words: ['search', 'store', '-s', 'MMR'] },
  seed: { relation: 'same', words: ['seed', 'Cache it', '-k', 'idea'] },
  seeds: { records: 'seeds', relation: 'records', words: ['seeds', '-p', 'MMR'] },
  start: { relation: 'same', words: ['start', 'MMR-3'] },
  status: { relation: 'compact', words: ['status', 'MMR-3'] },
  'store export': { relation: 'same', words: ['store', 'export', '-'] },
  'store import': {
    before: async (board) => {
      writeFileSync(join(board.dir, 'doc.json'), JSON.stringify(await board.store.export()));
    },
    relation: 'same',
    words: ['store', 'import', '{dir}/doc.json', '--resume'],
  },
  submit: { relation: 'same', words: ['submit', 'MMR-5'] },
  tag: { relation: 'same', words: ['tag', 'MMR-5', 'design'] },
  tree: { relation: 'compact', words: ['tree', 'MMR'] },
  triage: { relation: 'compact', words: ['triage', 'MMR'] },
  unarchive: {
    before: (board) => board.engine.archive({ id: 'XX' }),
    relation: 'same',
    words: ['unarchive', 'XX'],
  },
  unblock: { relation: 'same', words: ['unblock', 'MMR-6'] },
  undepend: { relation: 'same', words: ['undepend', 'MMR-4', '--on', 'MMR-3'] },
  unpark: {
    before: (board) => board.engine.park({ id: 'MMR-3' }),
    relation: 'same',
    words: ['unpark', 'MMR-3'],
  },
  unqueue: {
    before: (board) => board.engine.queue({ id: 'MMR-3', session: 'run-1' }),
    relation: 'same',
    words: ['unqueue', 'MMR-3', 'run cancelled'],
  },
  untag: { relation: 'same', words: ['untag', 'MMR-3', 'alpha'] },
  update: { relation: 'same', words: ['update', 'MMR-3', '--title', 'x'] },
};

/** Commands with a `jsonl` view this file does not run, each with where its output is held instead. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  'installation-protocol':
    'prints the protocol line core probes for under every format (installation.test.ts)',
  pair: 'needs a pairing host; pair.test.ts holds its jsonl to one record',
  version: 'prints the bare version under every format (version.parity.test.ts)',
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The array a json document holds under `key`, if it is an object. */
const recordsOf = (document: unknown, key: string): unknown =>
  isRecord(document) ? document[key] : undefined;

/** A sample run under one format, on a fresh board, its random ids named `<uuid>`. */
async function under(sample: Sample, format: string): Promise<ParityRun> {
  const open = await openBoard();
  try {
    await sample.before?.(open.board);
    const c = bindCase(argvCase([...sample.words, '-f', format]), {
      ...open.tokens,
      dir: open.board.dir,
    });
    const run = await runNew((argv) => open.board.app('MMR', argv), c);
    return { ...run, stdout: run.stdout.replaceAll(UUID, '<uuid>') };
  } finally {
    await open.close();
  }
}

test('every command with a jsonl view is sampled here or held elsewhere', async () => {
  const open = await openBoard();
  const declared: string[] = [];
  try {
    const visit = (
      node: ReturnType<ReturnType<ParityBoard['app']>['inspect']>['root'],
      path: string[],
    ): void => {
      if ((node.result?.views ?? []).includes('jsonl')) {
        declared.push(path.join(' '));
      }
      for (const child of node.children) {
        visit(child, [...path, child.name ?? '']);
      }
    };
    visit(open.board.app().inspect().root, []);
  } finally {
    await open.close();
  }
  expect(declared.toSorted()).toEqual(
    [...Object.keys(SAMPLES), ...Object.keys(ELSEWHERE)].toSorted(),
  );
  expect(Object.keys(SAMPLES).filter((path) => path in ELSEWHERE)).toEqual([]);
});

test.each(Object.entries(SAMPLES))(
  '%s jsonl relates to its json document as declared',
  async (_path, sample) => {
    const json = await under(sample, 'json');
    const jsonl = await under(sample, 'jsonl');
    expect([json.exitCode, jsonl.exitCode], JSON.stringify([json.failure, jsonl.failure])).toEqual([
      0, 0,
    ]);
    const document = parseJson(json.stdout);
    if (sample.relation === 'same') {
      expect(jsonl.stdout).toBe(json.stdout);
    } else if (sample.relation === 'compact') {
      expect(jsonl.stdout).toBe(`${JSON.stringify(document)}\n`);
    } else {
      const array = sample.records === undefined ? document : recordsOf(document, sample.records);
      expect(Array.isArray(array)).toBe(true);
      const lines = jsonl.stdout.split('\n').filter((line) => line !== '');
      // Every element, once, in order: a dropped, repeated, or reordered row fails.
      expect(lines).toEqual((array as unknown[]).map((record) => JSON.stringify(record)));
      expect(lines.length).toBeGreaterThan(0);
    }
  },
);
