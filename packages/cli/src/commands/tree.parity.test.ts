import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const tree = (name: string, id?: string, options: ParityCase['options'] = {}): ParityCase => ({
  ...(id === undefined ? {} : { args: { id } }),
  name,
  options,
  path: ['tree'],
});

const CASES: ParityCase[] = [
  tree('tree MMR', 'MMR'),
  tree('tree MMR -f records', 'MMR', { format: 'records' }),
  tree('tree MMR -f table', 'MMR', { format: 'table' }),
  tree('tree MMR -f ids', 'MMR', { format: 'ids' }),
  tree('tree MMR -f json', 'MMR', { format: 'json' }),
  tree('tree MMR -f jsonl', 'MMR', { format: 'jsonl' }),
  tree('tree MMR --ascii', 'MMR', { ascii: true }),
  tree('tree MMR-2', 'MMR-2'),
  tree('tree MMR-2 -f json', 'MMR-2', { format: 'json' }),
  tree('tree MMR-3 -f jsonl', 'MMR-3', { format: 'jsonl' }),
  tree('tree MMR-4 -f ids', 'MMR-4', { format: 'ids' }),
  tree('tree XX', 'XX'),
  // Refusals Mimir raises.
  tree('tree MMR-99', 'MMR-99'),
  tree('tree NOPE', 'NOPE'),
  // Faults Loom's parser raises.
  tree('tree (no id)'),
  argvCase(['tree', 'MMR']),
  argvCase(['tree', 'MMR-2', '-f', 'json']),
  argvCase(['tree', 'MMR-99', '-f', 'json']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['tree', 'MMR', 'extra']),
  // On a color terminal.
  argvCase(['tree', 'MMR'], true),
  argvCase(['tree', 'MMR-2', '-f', 'records'], true),
];

parityCases(/^tree /, CASES);
