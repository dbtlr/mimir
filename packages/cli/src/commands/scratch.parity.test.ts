import { argvLine } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

/** Stands for the first pad's UUID, which exists only once the board is built. */
const PAD = '<pad>';

const list = (name: string, options: ParityCase['options'] = {}, bound?: string): ParityCase => ({
  name,
  options,
  path: ['scratch', 'list'],
  ...(bound === undefined ? {} : { bound }),
});

const get = (name: string, id?: string, options: ParityCase['options'] = {}): ParityCase => ({
  ...(id === undefined ? {} : { args: { id } }),
  name,
  options,
  path: ['scratch', 'get'],
});

const CASES: ParityCase[] = [
  // The pad list, through every format.
  list('scratch list -s MMR', { scope: 'MMR' }),
  list('scratch list -s MMR -f records', { format: 'records', scope: 'MMR' }),
  list('scratch list -s MMR -f ids', { format: 'ids', scope: 'MMR' }),
  list('scratch list -s MMR -f json', { format: 'json', scope: 'MMR' }),
  list('scratch list -s MMR -f jsonl', { format: 'jsonl', scope: 'MMR' }),
  list('scratch list -s XX -f json', { format: 'json', scope: 'XX' }),
  list('scratch list (bound to MMR)', {}, 'MMR'),
  list('scratch list -s XX (bound to MMR)', { scope: 'XX' }, 'MMR'),
  // One pad, through every format.
  get('scratch get <pad>', PAD),
  get('scratch get <pad> -f records', PAD, { format: 'records' }),
  get('scratch get <pad> -f ids', PAD, { format: 'ids' }),
  get('scratch get <pad> -f json', PAD, { format: 'json' }),
  get('scratch get <pad> -f jsonl', PAD, { format: 'jsonl' }),
  get('scratch get <pad> --ascii', PAD, { ascii: true }),
  // Refusals Mimir raises.
  get('scratch get nope', 'nope'),
  // Faults Loom's parser raises.
  get('scratch get (no id)'),
  list('scratch list -s MMR --bogus', { bogus: true, scope: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argvLine('scratch list -s MMR'),
  argvLine('scratch list --scope MMR --format ids'),
  argvLine('scratch get <pad> -f json'),
  argvLine('scratch get nope -f json'),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvLine('scratch list -s MMR -s XX -f ids'),
  argvLine('scratch list extra -s MMR'),
  // No subcommand and an unknown one: both refuse, in Loom's words now.
  argvLine('scratch'),
  argvLine('scratch bogus'),
  // A project the old CLI listed anyway; the new CLI names one real board (ADR 0034).
  argvLine('scratch list -s ZZZ'),
  // On a color terminal.
  argvLine('scratch list -s MMR', { tty: true }),
  argvLine('scratch get <pad> -f records', { tty: true }),
];

/** The case with the pad's UUID in place of its stand-in. */
function withPad(padId: string): (c: ParityCase) => ParityCase {
  const swap = (word: string): string => (word === PAD ? padId : word);
  return (c) => ({
    ...c,
    ...(c.args === undefined
      ? {}
      : { args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, swap(v)])) }),
    ...(c.argv === undefined ? {} : { argv: c.argv.map(swap) }),
  });
}

parityCases(/^scratch /, CASES, async (board) => {
  const first = await board.engine.scratchCreate({
    anchors: ['MMR-3'],
    project: 'MMR',
    title: 'Shape the watcher',
  });
  const withAgenda = await board.engine.scratchAgendaAdd({
    content: 'verify recovery',
    expectedUpdatedAt: first.updatedAt,
    id: first.id,
  });
  await board.engine.scratchCheckpoint({
    content: 'settled the API',
    expectedUpdatedAt: withAgenda.updatedAt,
    id: first.id,
  });
  await board.engine.scratchCreate({ project: 'MMR', title: 'A second pad' });
  await board.engine.scratchCreate({ project: 'XX', title: 'Elsewhere' });
  return withPad(first.id);
});
