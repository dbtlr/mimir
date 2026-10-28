import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const projects = (
  name: string,
  options: ParityCase['options'] = {},
  bound?: string,
): ParityCase => ({
  name,
  options,
  path: ['projects'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  projects('projects'),
  projects('projects -f records', { format: 'records' }),
  projects('projects -f ids', { format: 'ids' }),
  projects('projects -f json', { format: 'json' }),
  projects('projects -f jsonl', { format: 'jsonl' }),
  projects('projects --ascii', { ascii: true }),
  // The binding never narrows the listing.
  projects('projects (bound to MMR)', {}, 'MMR'),
  projects('projects --status archived', { status: 'archived' }),
  projects('projects --status archived -f json', { format: 'json', status: 'archived' }),
  projects('projects --status all -f ids', { format: 'ids', status: 'all' }),
  projects('projects --status active -f ids', { format: 'ids', status: 'active' }),
  // Refusals Mimir raises.
  projects('projects --status bogus', { status: 'bogus' }),
  // Faults Loom's parser raises, where the old CLI named its own.
  projects('projects --scope MMR', { scope: 'MMR' }),
  projects('projects --limit 2', { limit: '2' }),
  argvCase(['projects', '-f', 'json']),
  argvCase(['projects', '--status', 'all', '--format', 'ids']),
  argvCase(['projects', '--status', 'bogus', '-f', 'json']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['projects', '--status', 'all', '--status', 'archived', '-f', 'ids']),
  argvCase(['projects', 'extra']),
  // Options that belong to other commands: the old CLI's Mimir hint is lost.
  argvCase(['projects', '-q', 'x']),
  argvCase(['projects', '-t', 'x']),
  argvCase(['projects', '-n', '1']),
  // On a color terminal.
  argvCase(['projects'], true),
  argvCase(['projects', '-f', 'records'], true),
];

parityCases(import.meta.url, CASES, async (board) => {
  // An archived project, so the shelves differ.
  await board.engine.create({ key: 'OLD', name: 'retired', type: 'project' });
  await board.engine.archive({ id: 'OLD' });
  return undefined;
});
