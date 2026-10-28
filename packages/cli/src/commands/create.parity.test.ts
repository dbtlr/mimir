import { argvCase, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { NODE_REDIRECTS } from '../testing/redirects';
import { writeCases } from '../testing/writes';

/** `create` with its words, so each name leads with `create`. */
const create = (words: string[], tty?: true): ParityCase => argvCase(['create', ...words], tty);

const PROJECT: ParityCase[] = [
  create(['project', 'Gamma', '--key', 'GAM', '-y']),
  create(['project', 'Gamma', '--key', 'GAM', '--yes']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'json']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'jsonl']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '-f', 'ids']),
  create(['project', '--name', 'Gamma', '--key', 'GAM', '-y']),
  create(['project', '--name', 'Gamma', '--key', 'GAM', '-y', '-f', 'json']),
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
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--bogus']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--parent', 'MMR']),
  create(['project', 'Gamma', '--key', 'GAM', '-y', '--groomed']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  create(['project', 'Gamma', '--key', 'GAM', '--key', 'GAN', '-y']),
  create(['project', 'Gamma', 'Delta', '--key', 'GAM', '-y']),
];

const INITIATIVE: ParityCase[] = [
  create(['initiative', 'Growth', '--parent', 'MMR']),
  create(['initiative', 'Growth', '--parent', 'MMR', '-f', 'json']),
  create(['initiative', 'Growth', '--parent', 'MMR', '-f', 'jsonl']),
  create(['initiative', 'Growth', '--parent', 'MMR', '-f', 'ids']),
  create(['initiative', 'Growth', '--parent', 'MMR', '-f', 'table']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--ascii']),
  create(['initiative', 'Growth', '--parent', 'MMR'], true),
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
  create(['initiative', 'Growth', '--parent', 'MMR', '--bogus']),
  create(['initiative', '--weird-title', '--parent', 'MMR']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  create(['initiative', 'Growth', 'More', '--parent', 'MMR']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--target', '2026-11']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--groomed']),
  create(['initiative', 'Growth', '--parent', 'MMR', '--remote', 'x']),
];

const PHASE: ParityCase[] = [
  create(['phase', 'Beta', '--parent', 'MMR-1']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '-f', 'json']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '-f', 'jsonl']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '-f', 'ids']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '--ascii']),
  create(['phase', 'Beta', '--parent', 'MMR-1', '-f', 'table']),
  create(['phase', 'Beta', '--parent', 'MMR-1'], true),
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
  create(['phase', 'Beta', '--parent', 'MMR-1', '--bogus']),
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
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--bogus']),
  create(['task', '--weird-title', '--parent', 'MMR-2']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--target', '2026-11']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--open-ended']),
  create(['task', 'Ship docs', '--parent', 'MMR-2', '--parent', 'MMR-1']),
  create(['task', 'Ship docs', 'More', '--parent', 'MMR-2']),
];

// The type words are unknown to the old CLI as well, which answers in its own voice.
const OTHER: ParityCase[] = [
  { ...argvCase(['create', 'epic', 'Title']), path: ['create'] },
  argvCase(['create']),
];

// Misplaced flags, redirected as the old CLI redirected them.
const REDIRECTS: ParityCase[] = NODE_REDIRECTS.filter((line) => line.startsWith('create ')).map(
  (line) => argvLine(line),
);

const CASES = [...PROJECT, ...INITIATIVE, ...PHASE, ...TASK, ...OTHER, ...REDIRECTS];

writeCases(import.meta.url, CASES);
