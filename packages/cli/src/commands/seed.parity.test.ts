import { argvCase, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { writeCases } from '../testing/writes';

/** A case by name: the verb, its arguments in order, and its options. */
const verb = (
  name: string,
  path: string,
  args: Record<string, string> = {},
  options: ParityCase['options'] = {},
  rest: Partial<ParityCase> = {},
): ParityCase => ({ args, name, options, path: [path], ...rest });

const FILED = { kind: 'idea' };

// Every verb here echoes a seed through one set of views (render/seeds.ts), so
// the full format, `--ascii`, and terminal matrix runs once, on `seed`.
// `promote` keeps its `ids` and `json`, which print the task it spawned or
// linked rather than the seed. Every other case is one distinct input.
const CASES: ParityCase[] = [
  // seed: file one.
  verb('seed (bound)', 'seed', { title: 'Cache it' }, FILED, { bound: 'MMR' }),
  verb('seed -f ids', 'seed', { title: 'Cache it' }, { ...FILED, format: 'ids' }, { bound: 'MMR' }),
  verb(
    'seed -f json',
    'seed',
    { title: 'Cache it' },
    { ...FILED, format: 'json' },
    { bound: 'MMR' },
  ),
  verb(
    'seed -f jsonl',
    'seed',
    { title: 'Cache it' },
    { ...FILED, format: 'jsonl' },
    { bound: 'MMR' },
  ),
  verb(
    'seed -f table',
    'seed',
    { title: 'Cache it' },
    { ...FILED, format: 'table' },
    { bound: 'MMR' },
  ),
  verb('seed --ascii', 'seed', { title: 'Cache it' }, { ...FILED, ascii: true }, { bound: 'MMR' }),
  verb(
    'seed --desc',
    'seed',
    { title: 'Cache it' },
    { ...FILED, desc: 'Because it is slow.\n\nTwo paragraphs.' },
    { bound: 'MMR' },
  ),
  verb('seed -k bug', 'seed', { title: 'It breaks' }, { kind: 'bug' }, { bound: 'MMR' }),
  verb('seed -k feature', 'seed', { title: 'A hook' }, { kind: 'feature' }, { bound: 'MMR' }),
  verb(
    'seed --project XX (requester is the bound project)',
    'seed',
    { title: 'Ask' },
    { ...FILED, project: 'XX' },
    { bound: 'MMR' },
  ),
  verb(
    'seed --project MMR (self-filed)',
    'seed',
    { title: 'Own' },
    { ...FILED, project: 'MMR' },
    { bound: 'MMR' },
  ),
  verb('seed --project XX (unbound)', 'seed', { title: 'Ask' }, { ...FILED, project: 'XX' }),
  verb(
    'seed --scope XX (the scope is the requester)',
    'seed',
    { title: 'Ask' },
    { ...FILED, project: 'MMR', scope: 'XX' },
  ),
  verb('seed --scope all', 'seed', { title: 'Ask' }, { ...FILED, project: 'MMR', scope: 'all' }),
  // seed: refusals Mimir raises.
  verb('seed (unbound, no project)', 'seed', { title: 'Cache it' }, FILED),
  verb('seed (no kind)', 'seed', { title: 'Cache it' }, {}, { bound: 'MMR' }),
  verb('seed -k nope', 'seed', { title: 'Cache it' }, { kind: 'nope' }, { bound: 'MMR' }),
  verb('seed (blank title)', 'seed', { title: ' ' }, FILED, { bound: 'MMR' }),
  verb(
    'seed --project ZZ',
    'seed',
    { title: 'Cache it' },
    { ...FILED, project: 'ZZ' },
    { bound: 'MMR' },
  ),
  verb(
    'seed --project nope',
    'seed',
    { title: 'Cache it' },
    { ...FILED, project: 'nope' },
    { bound: 'MMR' },
  ),
  verb(
    'seed --project all',
    'seed',
    { title: 'Cache it' },
    { ...FILED, project: 'all' },
    { bound: 'MMR' },
  ),
  // seed: faults Loom's parser raises.
  verb(
    'seed -f yaml',
    'seed',
    { title: 'Cache it' },
    { ...FILED, format: 'yaml' },
    { bound: 'MMR' },
  ),
  // seed: through Loom's parser, as a shell spells it.
  argvCase(['seed', 'Cache it', '-k', 'idea', '-s', 'MMR']),
  argvCase(['seed', 'Ask', '--kind', 'bug', '-p', 'XX']),
  argvCase(['seed', 'Cache it', '-k', 'idea', '-s', 'MMR'], true),

  // promote: spawn a task, or link existing work.
  verb('promote MMR-s1 (no parent, no link)', 'promote', { id: 'MMR-s1' }, {}, { bound: 'MMR' }),
  verb('promote MMR-s1', 'promote', { id: 'MMR-s1' }, { parent: 'MMR-2' }),
  verb('promote MMR-s1 -f ids', 'promote', { id: 'MMR-s1' }, { format: 'ids', parent: 'MMR-2' }),
  verb('promote MMR-s1 -f json', 'promote', { id: 'MMR-s1' }, { format: 'json', parent: 'MMR-2' }),
  verb(
    'promote MMR-s1 with fields',
    'promote',
    { id: 'MMR-s1' },
    {
      desc: 'Spawned body.',
      parent: 'MMR-2',
      priority: 'p1',
      size: 'small',
      tag: ['alpha', 'beta'],
      title: 'Add the hook',
    },
  ),
  verb('promote MMR-s2 --parent', 'promote', { id: 'MMR-s2' }, { parent: 'MMR-2' }),
  verb('promote MMR-s1 --link', 'promote', { id: 'MMR-s1' }, { link: 'MMR-3' }),
  verb(
    'promote MMR-s1 --link -f json',
    'promote',
    { id: 'MMR-s1' },
    { format: 'json', link: 'MMR-3' },
  ),
  verb(
    'promote MMR-s1 --link -f ids',
    'promote',
    { id: 'MMR-s1' },
    { format: 'ids', link: 'MMR-3' },
  ),
  verb('promote MMR-s1 --size m', 'promote', { id: 'MMR-s1' }, { parent: 'MMR-2', size: 'm' }),
  verb('promote MMR-s1 -p p9', 'promote', { id: 'MMR-s1' }, { priority: 'p9' }),
  verb('promote MMR-s1 --size huge', 'promote', { id: 'MMR-s1' }, { size: 'huge' }),
  verb('promote MMR-3 (not a seed)', 'promote', { id: 'MMR-3' }, { parent: 'MMR-2' }),
  verb('promote nope', 'promote', { id: 'nope' }, { parent: 'MMR-2' }),
  verb('promote MMR-s99', 'promote', { id: 'MMR-s99' }, { parent: 'MMR-2' }),
  verb('promote MMR-s3 (settled)', 'promote', { id: 'MMR-s3' }, { parent: 'MMR-2' }),
  verb('promote MMR-s4 (promoted)', 'promote', { id: 'MMR-s4' }, { parent: 'MMR-2' }),
  verb('promote MMR-s1 --parent MMR-99', 'promote', { id: 'MMR-s1' }, { parent: 'MMR-99' }),
  verb('promote MMR-s1 --link MMR-99', 'promote', { id: 'MMR-s1' }, { link: 'MMR-99' }),
  argvCase(['promote', 'MMR-s1', '--parent', 'MMR-2', '-p', 'p1', '-t', 'alpha', '-t', 'beta']),

  // reject and resolve: settle a seed with a reason.
  verb('reject MMR-s1', 'reject', { id: 'MMR-s1', reason: 'out of scope' }),
  verb('reject MMR-s2', 'reject', { id: 'MMR-s2', reason: 'no longer wanted' }),
  verb('reject MMR-s5 (parked)', 'reject', { id: 'MMR-s5', reason: 'drop it' }),
  verb('reject MMR-s1 (blank reason)', 'reject', { id: 'MMR-s1', reason: ' ' }),
  verb('reject MMR-3 (not a seed)', 'reject', { id: 'MMR-3', reason: 'no' }),
  verb('reject MMR-s99', 'reject', { id: 'MMR-s99', reason: 'no' }),
  verb('reject MMR-s3 (settled)', 'reject', { id: 'MMR-s3', reason: 'again' }),
  verb('reject (no reason)', 'reject', { id: 'MMR-s1' }),
  argvCase(['reject', 'MMR-s1', 'out', 'of', 'scope']),
  // Reason words after `--` are text, not options.
  argvCase(['reject', 'MMR-s1', '--', '--out', 'of', 'scope']),
  argvCase(['reject', 'MMR-s1', 'later', '--', '-1', 'cycle']),
  argvCase(['resolve', 'MMR-s1', '--', '--shipped', 'in', 'MMR-40']),
  argvCase(['resolve', 'MMR-s1', 'done', '--', '-1', 'left']),
  // A bare `--` is no words: both CLIs refuse the empty reason.
  argvCase(['reject', 'MMR-s1', '--']),
  verb('resolve MMR-s1', 'resolve', { id: 'MMR-s1', reason: 'shipped in MMR-40' }),
  verb('resolve MMR-s4 (ready to resolve)', 'resolve', { id: 'MMR-s4', reason: 'shipped' }),
  verb('resolve MMR-s1 (blank reason)', 'resolve', { id: 'MMR-s1', reason: '' }),
  verb('resolve MMR-3 (not a seed)', 'resolve', { id: 'MMR-3', reason: 'done' }),
  verb('resolve MMR-s99', 'resolve', { id: 'MMR-s99', reason: 'done' }),
  verb('resolve MMR-s3 (settled)', 'resolve', { id: 'MMR-s3', reason: 'again' }),
  verb('resolve MMR-s5 (parked)', 'resolve', { id: 'MMR-s5', reason: 'done' }),
  verb('resolve (no reason)', 'resolve', { id: 'MMR-s1' }),
  argvCase(['resolve', 'MMR-s1', 'shipped', 'in', 'MMR-40']),
  // A misplaced flag, redirected as the old CLI redirected it.
  argvLine('seed x -k idea -s MMR --parent MMR-2'),
];

writeCases(import.meta.url, CASES);
