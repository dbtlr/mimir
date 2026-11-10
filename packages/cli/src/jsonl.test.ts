import { beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseJson } from '@mimir/helpers';

import { argvCase } from './testing/argv-case';
import type { ParityBoard } from './testing/fixture';
import { runNew } from './testing/parity';
import type { ParityRun } from './testing/parity';
import { bindCase, boardTemplate, openCopy } from './testing/writes';
import type { BoardTemplate } from './testing/writes';

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
 * of contract and not a fix here. Each sample runs on its own copy of one
 * board per format, so neither run sees the other's write; the random
 * Scratchpad ids read as `<uuid>`, as a write that creates a pad draws a new
 * one on each copy.
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

/** One sample per distinct view declaration, keyed by its path. */
const SAMPLES: Readonly<Record<string, Sample>> = {
  annotate: { relation: 'same', words: ['annotate', 'MMR-3', 'a note'] },
  archive: { relation: 'same', words: ['archive', 'XX'] },
  artifacts: { records: 'artifacts', relation: 'records', words: ['artifacts', '-s', 'MMR'] },
  bind: { relation: 'same', words: ['bind', 'MMR'] },
  doctor: {
    before: (board) => {
      board.findings.push(FINDING);
    },
    relation: 'records',
    words: ['doctor', '-s', 'MMR'],
  },
  done: { relation: 'same', words: ['done', 'MMR-5'] },
  get: { relation: 'same', words: ['get', 'MMR-3'] },
  list: { records: 'tasks', relation: 'records', words: ['list', '-s', 'MMR'] },
  overview: { relation: 'compact', words: ['overview', '-s', 'MMR'] },
  'scratch create': { relation: 'compact', words: ['scratch', 'create', 'Index', '-s', 'MMR'] },
  'scratch get': { relation: 'compact', words: ['scratch', 'get', '{pad}'] },
  'scratch list': {
    records: 'scratchpads',
    relation: 'records',
    words: ['scratch', 'list', '-s', 'MMR'],
  },
  search: { records: 'results', relation: 'records', words: ['search', 'store', '-s', 'MMR'] },
  seed: { relation: 'same', words: ['seed', 'Cache it', '-k', 'idea'] },
  seeds: { records: 'seeds', relation: 'records', words: ['seeds', '-p', 'MMR'] },
  status: { relation: 'compact', words: ['status', 'MMR-3'] },
  'store export': { relation: 'same', words: ['store', 'export', '-'] },
  'store import': {
    before: async (board) => {
      writeFileSync(join(board.dir, 'doc.json'), JSON.stringify(await board.store.export()));
    },
    relation: 'same',
    words: ['store', 'import', '{dir}/doc.json', '--resume'],
  },
  tag: { relation: 'same', words: ['tag', 'MMR-5', 'design'] },
  tree: { relation: 'compact', words: ['tree', 'MMR'] },
  triage: { relation: 'compact', words: ['triage', 'MMR'] },
  update: { relation: 'same', words: ['update', 'MMR-3', '--title', 'x'] },
};

/**
 * Commands whose `jsonl` view is declared once with a sampled command's, so
 * the sample proves both. The key is the command, the value the sampled
 * command that shares its view declaration.
 */
const SHARES_VIEW_WITH: Readonly<Record<string, string>> = {
  abandon: 'done',
  attach: 'tag',
  block: 'done',
  'create initiative': 'annotate',
  'create phase': 'annotate',
  'create project': 'tag',
  'create task': 'annotate',
  depend: 'annotate',
  groom: 'tag',
  move: 'annotate',
  next: 'list',
  park: 'done',
  projects: 'list',
  promote: 'seed',
  queue: 'done',
  reject: 'seed',
  reopen: 'done',
  reorder: 'annotate',
  resolve: 'seed',
  return: 'done',
  'scratch agenda': 'scratch create',
  'scratch checkpoint': 'scratch create',
  'scratch discard': 'scratch create',
  'scratch freeze': 'scratch create',
  'scratch update': 'scratch create',
  start: 'done',
  submit: 'done',
  unarchive: 'archive',
  unblock: 'done',
  undepend: 'annotate',
  unpark: 'done',
  unqueue: 'done',
  untag: 'tag',
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

/** The board every sample copies, built once. */
let template: BoardTemplate;
beforeAll(async () => {
  template = await boardTemplate();
});

/** A sample run under one format, on its own copy of the board, its random ids named `<uuid>`. */
async function under(sample: Sample, format: string): Promise<ParityRun> {
  const open = await openCopy(template);
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
  const open = await openCopy(template);
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
    [
      ...Object.keys(SAMPLES),
      ...Object.keys(SHARES_VIEW_WITH),
      ...Object.keys(ELSEWHERE),
    ].toSorted(),
  );
  const sampledAndHeldElsewhere = Object.keys(SAMPLES).filter(
    (path) => path in ELSEWHERE || path in SHARES_VIEW_WITH,
  );
  expect(sampledAndHeldElsewhere).toEqual([]);
  expect(Object.keys(SHARES_VIEW_WITH).filter((path) => path in ELSEWHERE)).toEqual([]);
  // A shared view names a command this file samples.
  expect(Object.values(SHARES_VIEW_WITH).filter((path) => !(path in SAMPLES))).toEqual([]);
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
