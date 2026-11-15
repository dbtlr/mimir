import { argvLine } from '../testing/argv-case';
import { writeCases } from '../testing/writes';
import type { Setup, SetupCase } from '../testing/writes';

const running: Setup = async (board) => {
  await board.engine.deliveryStart({ id: 'MMR-d1' });
};
const milestone: Setup = async (board) => {
  await running(board);
  await board.engine.deliverySubmit({ id: 'MMR-d1' });
};
const staged: Setup = async (board) => {
  await milestone(board);
  const delivery = await board.engine.getDelivery({ id: 'MMR-d1' });
  for (const id of delivery.members) {
    await board.engine.start({ id });
    await board.engine.submit({ id });
    await board.engine.stage({ id });
  }
};
const cases: SetupCase[] = [
  ...(['records', 'table', 'ids', 'json', 'jsonl'] as const).map((format) =>
    argvLine(`start MMR-d1 -f ${format}`),
  ),
  argvLine('start MMR-d1 --session explicit'),
  argvLine('block MMR-d1 reason --on you'),
  argvLine('block MMR-d1 reason'),
  argvLine('park MMR-d1 reason'),
  {
    ...argvLine('unblock MMR-d1'),
    setup: async (b) => {
      await b.engine.deliveryBlock({ id: 'MMR-d1', reason: 'wait' });
    },
  },
  {
    ...argvLine('unpark MMR-d1'),
    setup: async (b) => {
      await b.engine.deliveryPark({ id: 'MMR-d1', reason: 'wait' });
    },
  },
  { ...argvLine('submit MMR-d1'), setup: running },
  { ...argvLine('return MMR-d1 revise'), setup: milestone },
  { ...argvLine('land MMR-d1 -f json'), setup: staged },
  { ...argvLine('abandon MMR-d1 reset -f json'), setup: running },
  argvLine('abandon MMR-d1'),
  { ...argvLine('land MMR-d1'), setup: milestone },
];
writeCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({
    agreement: 'Terms',
    phase: 'MMR-2',
    tasks: ['MMR-3'],
    title: 'Attempt',
  });
});
