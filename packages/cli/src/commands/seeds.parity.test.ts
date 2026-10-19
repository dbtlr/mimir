import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const seeds = (name: string, options: ParityCase['options'] = {}, bound?: string): ParityCase => ({
  name,
  options,
  path: ['seeds'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // The queue, through every format.
  seeds('seeds -p MMR', { project: 'MMR' }),
  seeds('seeds -p MMR -f records', { format: 'records', project: 'MMR' }),
  seeds('seeds -p MMR -f ids', { format: 'ids', project: 'MMR' }),
  seeds('seeds -p MMR -f json', { format: 'json', project: 'MMR' }),
  seeds('seeds -p MMR -f jsonl', { format: 'jsonl', project: 'MMR' }),
  seeds('seeds -p MMR --ascii', { ascii: true, project: 'MMR' }),
  seeds('seeds -s MMR', { scope: 'MMR' }),
  seeds('seeds -p XX -f json', { format: 'json', project: 'XX' }),
  // The clone binding supplies the project; an explicit one overrides it.
  seeds('seeds (bound to MMR)', {}, 'MMR'),
  seeds('seeds (bound to MMR) -f ids', { format: 'ids' }, 'MMR'),
  seeds('seeds -p XX (bound to MMR)', { project: 'XX' }, 'MMR'),
  // The status universe, the lanes, and the sort.
  seeds('seeds -p MMR --status all', { project: 'MMR', status: 'all' }),
  seeds('seeds -p MMR --status parked -f ids', { format: 'ids', project: 'MMR', status: 'parked' }),
  seeds('seeds -p MMR --status rejected', { project: 'MMR', status: 'rejected' }),
  seeds('seeds -p MMR --status live -f json', { format: 'json', project: 'MMR', status: 'live' }),
  seeds('seeds -p MMR --sort desc -f ids', { format: 'ids', project: 'MMR', sort: 'desc' }),
  seeds('seeds -p MMR --status all --sort desc', { project: 'MMR', sort: 'desc', status: 'all' }),
  seeds('seeds -p MMR --grouped', { grouped: true, project: 'MMR' }),
  seeds('seeds -p MMR --status all --grouped', { grouped: true, project: 'MMR', status: 'all' }),
  seeds('seeds -p MMR --status all --grouped --ascii', {
    ascii: true,
    grouped: true,
    project: 'MMR',
    status: 'all',
  }),
  seeds('seeds -p MMR --grouped -f json', { format: 'json', grouped: true, project: 'MMR' }),
  // Selection.
  seeds('seeds -p MMR --requester XX -f ids', { format: 'ids', project: 'MMR', requester: 'XX' }),
  seeds('seeds -p MMR --after created_at:2020-01-01 -f ids', {
    after: ['created_at:2020-01-01'],
    format: 'ids',
    project: 'MMR',
  }),
  seeds('seeds -p MMR --before created_at:2020-01-01', {
    before: ['created_at:2020-01-01'],
    project: 'MMR',
  }),
  seeds('seeds -p MMR --on created_at:2020-01-01 --tz Asia/Tokyo -f ids', {
    format: 'ids',
    on: ['created_at:2020-01-01'],
    project: 'MMR',
    tz: 'Asia/Tokyo',
  }),
  seeds('seeds -p MMR --at-or-after created_at:2020-01-01T00:00Z -f ids', {
    'at-or-after': ['created_at:2020-01-01T00:00Z'],
    format: 'ids',
    project: 'MMR',
  }),
  // An empty queue.
  seeds('seeds -p MMR --requester ZZ', { project: 'MMR', requester: 'ZZ' }),
  seeds('seeds -p MMR --requester ZZ -f json', { format: 'json', project: 'MMR', requester: 'ZZ' }),
  seeds('seeds -p MMR --requester ZZ -f ids', { format: 'ids', project: 'MMR', requester: 'ZZ' }),
  seeds('seeds -p MMR --requester ZZ --grouped', {
    grouped: true,
    project: 'MMR',
    requester: 'ZZ',
  }),
  // Refusals Mimir raises.
  seeds('seeds -p MMR --status bogus', { project: 'MMR', status: 'bogus' }),
  seeds('seeds -p MMR --sort sideways', { project: 'MMR', sort: 'sideways' }),
  seeds('seeds -p MMR --after title:x', { after: ['title:x'], project: 'MMR' }),
  seeds('seeds -p MMR --tz Mars/Base', { project: 'MMR', tz: 'Mars/Base' }),
  seeds('seeds -p NOPE', { project: 'NOPE' }),
  seeds('seeds -p mmr', { project: 'mmr' }),
  // Faults Loom's parser raises.
  seeds('seeds -p MMR --bogus', { bogus: true, project: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argvCase(['seeds', '-p', 'MMR']),
  argvCase(['seeds', '-p', 'MMR', '-f', 'json']),
  argvCase(['seeds', '--project', 'MMR', '--status', 'all', '--sort', 'desc', '--format', 'ids']),
  argvCase(['seeds', '-s', 'MMR', '--grouped']),
  argvCase(['seeds', '-p', 'MMR', '--status', 'bogus', '-f', 'json']),
  argvCase(['seeds', '-p', 'MMR', '--bogus', '-f', 'json']),
  argvCase(['seeds', '-p', 'MMR', '-s', 'XX', '-f', 'ids']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['seeds', '-p', 'MMR', '--status', 'new', '--status', 'all', '-f', 'ids']),
  argvCase(['seeds', 'extra', '-p', 'MMR']),
  argvCase(['-p', 'MMR', 'seeds', '-f', 'ids'], undefined, undefined, ['seeds']),
  // On a color terminal.
  argvCase(['seeds', '-p', 'MMR'], true),
  argvCase(['seeds', '-p', 'MMR', '--status', 'all', '--grouped'], true),
  argvCase(['seeds', '-p', 'MMR', '--requester', 'ZZ'], true),
];

parityCases(/^seeds /, CASES, async (board) => {
  // One seed in each lane: parked, promoted, and rejected beside the fixture's new one.
  const parked = await board.engine.seedCreate({
    description: 'Not now.',
    kind: 'idea',
    project: 'MMR',
    title: 'A parked idea',
  });
  await board.engine.seedPark({ id: parked.id });
  const promoted = await board.engine.seedCreate({
    kind: 'feature',
    project: 'MMR',
    requester: 'XX',
    title: 'A promoted ask',
  });
  await board.engine.seedPromote({ id: promoted.id, parent: 'MMR-2' });
  const rejected = await board.engine.seedCreate({
    kind: 'bug',
    project: 'MMR',
    title: 'A rejected report',
  });
  await board.engine.seedReject({ id: rejected.id, reason: 'not a bug' });
  await board.engine.seedCreate({ kind: 'idea', project: 'XX', title: 'Over there' });
  return undefined;
});
