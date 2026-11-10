import { argvCase, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { writeCases } from '../testing/writes';

// `create` prints two views: a project's notice, and the echo of a written
// node, which initiatives, phases, and tasks share. The full format, `--ascii`,
// and terminal matrix runs once for each, on `create project` and `create
// task`; every other case is one distinct input.

/** `create` with its words, so each name leads with `create`. */
const create = (words: string[], tty?: true): ParityCase => argvCase(['create', ...words], tty);

const PROJECT: ParityCase[] = [
  create(['project', 'Gamma', '--key', 'GAM', '-y']),
  create(['project', 'Gamma', '--key', 'GAM', '--yes']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'json']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'jsonl']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'ids']),
  create(['project', '--name', 'Gamma', '--key', 'GAM', '-y']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'table']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--ascii']),
  create(['project', 'Gamma', '--key', 'GAM', '-y'], true),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--desc', 'The third board.']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--remote', 'git@github.com:dbtlr/gamma.git']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-t', 'one', '-t', 'two']),
  // Refusals Mimir raises.
  create(['project', 'Gamma', '--key', 'GAM']),
  create(['project', 'Gamma', '--key', 'GAM', '-f', 'json']),
  create(['project', '--key', 'GAM', '-y']),
  create(['project', ' ', '--key', 'GAM', '-y']),
  create(['project', 'Gamma', '--key', 'MMR', '-y']),
  create(['project', 'Gamma', '--key', 'MMR', '-y', '-f', 'json']),
  create(['project', 'Gamma', '--key', 'g', '-y']),
  create(['project', 'Gamma', '--key', 'gam', '-y']),
  create(['project', 'Gamma', '--key', 'TOOLONG', '-y']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--remote', 'not a remote']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--remote', 'git@github.com:dbtlr/mimir.git']),
  // Faults Loom's parser raises.
  create(['project', 'Gamma', '-y']),
];

const INITIATIVE: ParityCase[] = [
  create(['initiative', 'Growth', '--parent', 'MMR']),
  create([
    'initiative',
    'Growth',
    '--parent',
    'MMR',
    '--desc',
    'Grow the board.',
    '--summary',
    'growth',
  ]),
  create(['initiative', 'Growth', '--parent', 'MMR', '-t', 'one', '--tag', 'two']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--open-ended']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--not-open-ended']),
  create(['initiative', '--parent', 'MMR', '--', '-Dash first']),
  // Refusals Mimir raises.
  create(['initiative', '--parent', 'MMR']),
  create(['initiative', '--parent', 'MMR', '-f', 'json']),
  create(['initiative', ' ', '--parent', 'MMR']),
  create(['initiative', 'Growth', '--parent', 'MMR-1']),
  create(['initiative', 'Growth', '--parent', 'mmr']),
  create(['initiative', 'Growth', '--parent', 'NOPE']),
  create(['initiative', 'Growth', '--parent', 'NOPE', '-f', 'json']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--open-ended', '--not-open-ended']),
  // Faults Loom's parser raises.
  create(['initiative', 'Growth']),
  create(['initiative', '--weird-title', '--parent', 'MMR']),
];

const PHASE: ParityCase[] = [
  create(['phase', 'Beta', '--parent', 'MMR-1']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '--target', '2027-01', '--desc', 'Second.']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '--summary', 'beta', '-t', 'one']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '--open-ended']),
  create(['phase', '--parent', 'MMR-1', '--', '-Dash first']),
  // Refusals Mimir raises.
  create(['phase', '--parent', 'MMR-1']),
  create(['phase', 'Beta', '--parent', 'MMR']),
  create(['phase', 'Beta', '--parent', 'MMR-3']),
  create(['phase', 'Beta', '--parent', 'MMR-2']),
  create(['phase', 'Beta', '--parent', 'MMR-99']),
  create(['phase', 'Beta', '--parent', 'MMR-99', '-f', 'json']),
  create(['phase', 'Beta', '--parent', 'MMR-a1']),
  create(['phase', 'Beta', '--parent', 'MMR-s1']),
  create(['phase', 'Beta', '--parent', 'nope']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '--target', 'someday']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '--open-ended', '--not-open-ended']),
  // Faults Loom's parser raises.
  create(['phase', 'Beta']),
];

const TASK: ParityCase[] = [
  create(['task', 'Ship docs', '--parent', 'MMR-2']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '-f', 'json']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '-f', 'jsonl']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '-f', 'ids']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '-f', 'table']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--ascii']),
  create(['task', 'Ship docs', '--parent', 'MMR-2'], true),
  create(['task', 'Ship docs', '--parent', 'MMR-1']),
  create(['task', 'Ship docs', '--parent', 'XX-2']),
  create([
    'task',
    'Ship docs',
    '--parent',
    'MMR-2',
    '--desc',
    'Write them.',
    '--summary',
    'docs',
    '--ref',
    'GH-12',
    '-t',
    'docs',
    '-t',
    'ship',
  ]),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--priority', 'p1', '--size', 'm']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '-p', 'p0', '--size', 'large']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--groomed']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--upstream', 'XX-s1']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--upstream', 'none']),
  create([
    'task',
    'Ship docs',
    '--parent',
    'MMR-2',
    '--host',
    'asgard',
    '--harness',
    'claude',
    '--session',
    's-1',
    '--branch',
    'docs',
  ]),
  create(['task', '--parent', 'MMR-2', '--', '-Dash first']),
  // Refusals Mimir raises.
  create(['task', '--parent', 'MMR-2']),
  create(['task', '--parent', 'MMR-2', '-f', 'json']),
  create(['task', ' ', '--parent', 'MMR-2']),
  create(['task', 'Ship docs', '--parent', 'MMR']),
  create(['task', 'Ship docs', '--parent', 'mmr-2']),
  create(['task', 'Ship docs', '--parent', 'MMR-99']),
  create(['task', 'Ship docs', '--parent', 'MMR-99', '-f', 'json']),
  create(['task', 'Ship docs', '--parent', 'MMR-3']),
  create(['task', 'Ship docs', '--parent', 'MMR-a1']),
  create(['task', 'Ship docs', '--parent', 'MMR-s1']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '-p', 'zz']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--size', 'huge']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--upstream', 'bogus']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--upstream', 'MMR-3']),
  // Faults Loom's parser raises.
  create(['task', 'Ship docs']),
  create(['task', '--weird-title', '--parent', 'MMR-2']),
];

// A misplaced flag, redirected as the old CLI redirected it, after the leading-dash title check.
const REDIRECTS: ParityCase[] = [argvLine('create task x --parent MMR-2 --direction x')];

const CASES = [...PROJECT, ...INITIATIVE, ...PHASE, ...TASK, ...REDIRECTS];

writeCases(import.meta.url, CASES);
