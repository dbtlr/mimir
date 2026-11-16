import { argvCase } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { writeCases } from '../testing/writes';

const argv = argvCase;

/** Every format of one item write: the changed records must match across them. */
const formats = (line: readonly string[]): ParityCase[] =>
  (['records', 'table', 'ids', 'json', 'jsonl'] as const).map((format) =>
    argv([...line, '-f', format]),
  );

const CASES: ParityCase[] = [
  ...formats(['item', 'add', 'MMR-3', 'Remove', 'the', 'retired', 'hint']),
  ...formats(['item', 'check', 'MMR-3', '1']),
  ...formats(['item', 'drop', 'MMR-3', '2', 'Covered', 'by', 'MMR-14']),
  argv(['item', 'add', 'MMR-3', 'a note', '--ascii']),
  argv(['item', 'add', 'MMR-3', '--', '-led by a dash']),
  argv(['item', 'add', 'MMR-3', 'a note'], true),
  argv(['item', 'drop', 'MMR-3', '2', '--reason', 'Covered by MMR-14']),
  argv(['item', 'drop', 'MMR-3', '2', '--', '-no longer needed']),
  // An item on a done task is allowed.
  argv(['item', 'add', 'MMR-6', 'late finding']),
  // Usage errors, refused before the store opens.
  ...['0', '-1', '1.5', 'one', '1e2', ''].map((number) =>
    argv(
      number.startsWith('-')
        ? ['item', 'check', 'MMR-3', '--', number]
        : ['item', 'check', 'MMR-3', number],
    ),
  ),
  argv(['item', 'drop', 'MMR-3', '0', 'reason']),
  argv(['item', 'check', 'MMR-3']),
  argv(['item', 'drop', 'MMR-3', '2']),
  argv(['item', 'drop', 'MMR-3', '2', ' ']),
  argv(['item', 'add', 'MMR-3']),
  argv(['item', 'add', 'MMR-3', ' ']),
  // Refusals Mimir raises.
  argv(['item', 'check', 'MMR-3', '3']),
  argv(['item', 'check', 'MMR-3', '9']),
  argv(['item', 'drop', 'MMR-3', '9', 'reason']),
  argv(['item', 'check', 'MMR-3', '2', '-f', 'json']),
  argv(['item', 'drop', 'MMR-3', '3', 'late']),
  argv(['item', 'add', 'MMR-99', 'a note']),
  argv(['item', 'add', 'nope', 'a note']),
  ...['MMR-2', 'MMR-1', 'MMR', 'MMR-a1', 'MMR-s1', 'MMR-d1', 'MMR-q1'].map((id) =>
    argv(['item', 'add', id, 'a note']),
  ),
];

writeCases(import.meta.url, CASES, async (board) => {
  const engine = board.engine;
  await engine.itemAdd({ content: 'First item', task: 'MMR-3' });
  await engine.itemAdd({ content: 'Second item', task: 'MMR-3' });
  await engine.itemAdd({ content: 'Third item', task: 'MMR-3' });
  await engine.itemCheck({ number: 3, task: 'MMR-3' });
});
