import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const cases: ParityCase[] = (['records', 'table', 'json', 'jsonl', 'ids'] as const).map(
  (format) => ({
    bound: 'MMR',
    name: `decisions -f ${format}`,
    options: { format },
    path: ['decisions'],
  }),
);
const filters: NonNullable<ParityCase['options']>[] = [
  { status: 'all' },
  { status: 'confirmed' },
  { status: 'overturned' },
  { class: ['product', 'architecture'], linked: true },
  { delivery: 'MMR-d1' },
  { class: ['wrong'] },
  { status: 'wrong' },
];
for (const options of filters) {
  cases.push({
    bound: 'MMR',
    name: `decisions ${JSON.stringify(options)}`,
    options: { ...options, format: 'json' },
    path: ['decisions'],
  });
}
parityCases(import.meta.url, cases, async (board) => {
  await board.engine.deliveryCreate({ phase: 'MMR-2', title: 'Attempt' });
  const base = { options: ['Here', 'There'], project: 'MMR', question: 'Where?', recommended: 1 };
  await board.engine.decide({ ...base, class: 'product', delivery: 'MMR-d1', tasks: ['MMR-3'] });
  const confirmed = await board.engine.decide({ ...base, class: 'other' });
  await board.engine.confirm({ id: confirmed.id });
  const overturned = await board.engine.decide({ ...base, class: 'architecture' });
  await board.engine.overturn({ id: overturned.id, option: 2 });
  return undefined;
});
