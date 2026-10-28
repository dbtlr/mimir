import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const status = (name: string, id?: string, options: ParityCase['options'] = {}): ParityCase => ({
  ...(id === undefined ? {} : { args: { id } }),
  name,
  options,
  path: ['status'],
});

const CASES: ParityCase[] = [
  // The default is json on every destination.
  status('status MMR-3', 'MMR-3'),
  status('status MMR-3 -f json', 'MMR-3', { format: 'json' }),
  status('status MMR-3 -f records', 'MMR-3', { format: 'records' }),
  status('status MMR-3 -f table', 'MMR-3', { format: 'table' }),
  status('status MMR-3 --ascii -f records', 'MMR-3', { ascii: true, format: 'records' }),
  // A container shows its rollup; a project reads too.
  status('status MMR-2 -f records', 'MMR-2', { format: 'records' }),
  status('status MMR-1 -f json', 'MMR-1', { format: 'json' }),
  status('status MMR -f json', 'MMR', { format: 'json' }),
  status('status MMR -f records', 'MMR', { format: 'records' }),
  status('status MMR-5 -f json', 'MMR-5', { format: 'json' }),
  status('status MMR-6 -f records', 'MMR-6', { format: 'records' }),
  // Refusals Mimir raises.
  status('status MMR-99', 'MMR-99'),
  status('status NOPE', 'NOPE'),
  status('status bogus', 'bogus'),
  // Faults Loom's parser raises.
  status('status (no id)'),
  status('status MMR-3 -f yaml', 'MMR-3', { format: 'yaml' }),
  argvCase(['status', 'MMR-3']),
  argvCase(['status', 'MMR-3', '-f', 'records']),
  argvCase(['status', 'MMR-99', '-f', 'json']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['status', 'MMR-3', '-f', 'ids']),
  argvCase(['status', 'MMR-3', 'extra']),
  // The old CLI printed text under jsonl; the new one prints a JSON document.
  argvCase(['status', 'MMR-3', '-f', 'jsonl']),
  // On a color terminal.
  argvCase(['status', 'MMR-3'], true),
  argvCase(['status', 'MMR-3', '-f', 'records'], true),
  argvCase(['status', 'MMR-2', '-f', 'records'], true),
  argvCase(['status', 'MMR', '-f', 'table'], true),
];

parityCases(import.meta.url, CASES);
