import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';
import { twinCases } from '../testing/twin';
import type { SetupCase } from '../testing/twin';

const overview = (
  name: string,
  options: ParityCase['options'] = {},
  bound?: string,
): ParityCase => ({
  name,
  options,
  path: ['overview'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // Piped, the default is json.
  overview('overview -s MMR', { scope: 'MMR' }),
  overview('overview -s MMR -f json', { format: 'json', scope: 'MMR' }),
  overview('overview -s MMR -f records', { format: 'records', scope: 'MMR' }),
  overview('overview -s MMR --ascii -f records', { ascii: true, format: 'records', scope: 'MMR' }),
  overview('overview -s XX -f records', { format: 'records', scope: 'XX' }),
  overview('overview -s XX -f json', { format: 'json', scope: 'XX' }),
  // The clone binding supplies the project; an explicit -s overrides it.
  overview('overview (bound to MMR)', {}, 'MMR'),
  overview('overview (bound to MMR) -f records', { format: 'records' }, 'MMR'),
  overview('overview -s XX (bound to MMR)', { scope: 'XX' }, 'MMR'),
  // Refusals Mimir raises.
  overview('overview -s NOPE', { scope: 'NOPE' }),
  overview('overview -s mmr', { scope: 'mmr' }),
  // Faults Loom's parser raises.
  overview('overview -s MMR --bogus', { bogus: true, scope: 'MMR' }),
  argvCase(['overview', '-s', 'MMR']),
  argvCase(['overview', '--scope', 'MMR', '--format', 'records']),
  argvCase(['overview', '-s', 'NOPE', '-f', 'json']),
  // A composite is no table or id set: the old CLI said so, Loom has no such view.
  argvCase(['overview', '-s', 'MMR', '-f', 'table']),
  argvCase(['overview', '-s', 'MMR', '-f', 'ids']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['overview', '-s', 'MMR', 'extra']),
  // The old CLI refused jsonl for a composite; the new one prints a JSON document.
  argvCase(['overview', '-s', 'MMR', '-f', 'jsonl']),
  // On a color terminal, where records is the explicit choice.
  argvCase(['overview', '-s', 'MMR'], true),
  argvCase(['overview', '-s', 'MMR', '-f', 'records'], true),
  argvCase(['overview', '-s', 'XX', '-f', 'records'], true),
];

parityCases(/^overview /, CASES, async (board) => {
  // An active scratchpad, so the overview's scratchpad section has a row.
  await board.engine.scratchCreate({ anchors: ['MMR-3'], project: 'MMR', title: 'Shape it' });
  return undefined;
});

const WORKER_CASES: SetupCase[] = [
  {
    ...argvCase(['overview', '-s', 'MMR', '-f', 'records']),
    name: 'overview worker session with unknown harness',
    setup: async (board) => {
      await board.engine.update({ id: 'MMR-5', workerSession: 'unknown-provider-worker' });
    },
  },
  {
    ...argvCase(['overview', '-s', 'MMR', '-f', 'records']),
    name: 'overview worker cleared',
    setup: async (board) => {
      await board.engine.update({ id: 'MMR-5', workerSession: null });
    },
  },
];

twinCases(/^overview worker /, WORKER_CASES);
