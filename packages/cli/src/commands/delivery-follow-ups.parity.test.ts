import { argvCase } from '../testing/argv-case';
import { writeCases } from '../testing/writes';
import type { Setup, SetupCase } from '../testing/writes';

const linked: Setup = async (board) => {
  await board.engine.deliveryUpdate({ follow_ups: ['MMR-3', 'MMR-s1'], id: 'MMR-d1' });
};
const cases: SetupCase[] = [
  ...(['records', 'table', 'ids', 'json', 'jsonl'] as const).map((format) =>
    argvCase(['update', 'MMR-d1', '--follow-up', 'MMR-3', '--follow-up', 'MMR-s1', '-f', format]),
  ),
  {
    ...argvCase([
      'update',
      'MMR-d1',
      '--unfollow-up',
      'MMR-3',
      '--unfollow-up',
      'MMR-s1',
      '-f',
      'json',
    ]),
    setup: linked,
  },
  { ...argvCase(['get', 'MMR-d1']), setup: linked },
  argvCase(['update', 'MMR-d1', '--follow-up', 'MMR-2']),
  argvCase(['update', 'MMR-3', '--follow-up', 'MMR-s1']),
  argvCase(['update', 'MMR-q1', '--follow-up', 'MMR-3']),
];
writeCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({ phase: 'MMR-2', tasks: [], title: 'Attempt' });
});
