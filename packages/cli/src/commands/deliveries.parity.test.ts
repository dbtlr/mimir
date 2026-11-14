import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const cases: ParityCase[] = (['records', 'table', 'json', 'jsonl', 'ids'] as const).flatMap(
  (format): ParityCase[] => [
    { bound: 'MMR', name: `deliveries -f ${format}`, options: { format }, path: ['deliveries'] },
    {
      args: { id: 'MMR-d1' },
      name: `get MMR-d1 -f ${format}`,
      options: { col: ['history'], format },
      path: ['get'],
    },
  ],
);
cases.push({
  args: { key: 'MMR-d1' },
  name: 'archive refuses a delivery identity',
  path: ['archive'],
});
parityCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({
    agreement: 'Reviewed terms',
    phase: 'MMR-2',
    project: 'MMR',
    time_cap_minutes: 30,
    title: 'Ship phase',
  });
  return undefined;
});
