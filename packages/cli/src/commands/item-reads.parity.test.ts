import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const CASES: ParityCase[] = [
  argvCase(['get', 'MMR-3']),
  argvCase(['get', 'MMR-3', '--col', 'items']),
  argvCase(['get', 'MMR-3', '--col', 'items', '--ascii']),
  argvCase(['get', 'MMR-3', '--col', 'items,history']),
  argvCase(['get', 'MMR-3', '-f', 'json']),
  argvCase(['get', 'MMR-3', '-f', 'jsonl']),
  argvCase(['get', 'MMR-3', '--col', 'items', '-f', 'json']),
  // A task with no items shows no items line; a container never carries the key.
  argvCase(['get', 'MMR-4']),
  argvCase(['get', 'MMR-4', '--col', 'items']),
  argvCase(['get', 'MMR-4', '-f', 'json']),
  argvCase(['get', 'MMR-2', '-f', 'json']),
  // The column belongs to a task's `get`, not to the set reads.
  argvCase(['list', '--col', 'items']),
];

parityCases(import.meta.url, CASES, async (board) => {
  const engine = board.engine;
  await engine.itemAdd({ content: 'Remove the retired hint', task: 'MMR-3' });
  await engine.itemAdd({ content: 'Rename the flag', task: 'MMR-3' });
  await engine.itemAdd({ content: 'Document the flag', task: 'MMR-3' });
  await engine.itemCheck({ number: 1, task: 'MMR-3' });
  await engine.itemDrop({ number: 2, reason: 'Covered by MMR-14', task: 'MMR-3' });
});
