import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const artifacts = (
  name: string,
  options: ParityCase['options'] = {},
  bound?: string,
): ParityCase => ({
  name,
  options,
  path: ['artifacts'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // The feed, through every format.
  artifacts('artifacts -s MMR', { scope: 'MMR' }),
  artifacts('artifacts -s MMR -f records', { format: 'records', scope: 'MMR' }),
  artifacts('artifacts -s MMR -f ids', { format: 'ids', scope: 'MMR' }),
  artifacts('artifacts -s MMR -f json', { format: 'json', scope: 'MMR' }),
  artifacts('artifacts -s MMR -f jsonl', { format: 'jsonl', scope: 'MMR' }),
  artifacts('artifacts -s MMR --ascii', { ascii: true, scope: 'MMR' }),
  artifacts('artifacts -s XX -f json', { format: 'json', scope: 'XX' }),
  // The clone binding supplies the project; an explicit -s overrides it.
  artifacts('artifacts (bound to MMR)', {}, 'MMR'),
  artifacts('artifacts (bound to MMR) -f ids', { format: 'ids' }, 'MMR'),
  artifacts('artifacts -s XX (bound to MMR)', { scope: 'XX' }, 'MMR'),
  // Selection and paging.
  artifacts('artifacts -s MMR -t session_summary', { scope: 'MMR', tag: 'session_summary' }),
  artifacts('artifacts -s MMR -q notes -f ids', { format: 'ids', query: 'notes', scope: 'MMR' }),
  artifacts('artifacts -s MMR -n 1 -f json', { format: 'json', limit: '1', scope: 'MMR' }),
  artifacts('artifacts -s MMR -n 1 --offset 1 -f ids', {
    format: 'ids',
    limit: '1',
    offset: '1',
    scope: 'MMR',
  }),
  artifacts('artifacts -s MMR --offset 5', { offset: '5', scope: 'MMR' }),
  artifacts('artifacts -s MMR --offset 5 -f json', { format: 'json', offset: '5', scope: 'MMR' }),
  artifacts('artifacts -s MMR --after created_at:2020-01-01 -f ids', {
    after: ['created_at:2020-01-01'],
    format: 'ids',
    scope: 'MMR',
  }),
  artifacts('artifacts -s MMR --before created_at:2020-01-01', {
    before: ['created_at:2020-01-01'],
    scope: 'MMR',
  }),
  artifacts('artifacts -s MMR --on created_at:2020-01-01 --tz Asia/Tokyo -f ids', {
    format: 'ids',
    on: ['created_at:2020-01-01'],
    scope: 'MMR',
    tz: 'Asia/Tokyo',
  }),
  artifacts('artifacts -s MMR --at-or-after created_at:2020-01-01T00:00Z -f ids', {
    'at-or-after': ['created_at:2020-01-01T00:00Z'],
    format: 'ids',
    scope: 'MMR',
  }),
  artifacts('artifacts -s MMR --at-or-before created_at:2020-01-01T00:00Z', {
    'at-or-before': ['created_at:2020-01-01T00:00Z'],
    scope: 'MMR',
  }),
  // An empty feed.
  artifacts('artifacts -s MMR -t nothing', { scope: 'MMR', tag: 'nothing' }),
  artifacts('artifacts -s MMR -t nothing -f json', {
    format: 'json',
    scope: 'MMR',
    tag: 'nothing',
  }),
  artifacts('artifacts -s MMR -t nothing -f ids', { format: 'ids', scope: 'MMR', tag: 'nothing' }),
  // Refusals Mimir raises.
  artifacts('artifacts -s MMR -n 2x', { limit: '2x', scope: 'MMR' }),
  artifacts('artifacts -s MMR --offset 2x', { offset: '2x', scope: 'MMR' }),
  artifacts('artifacts -s MMR --after title:x', { after: ['title:x'], scope: 'MMR' }),
  artifacts('artifacts -s MMR --after 2020-01-01', { after: ['2020-01-01'], scope: 'MMR' }),
  artifacts('artifacts -s MMR --after created_at:someday', {
    after: ['created_at:someday'],
    scope: 'MMR',
  }),
  artifacts('artifacts -s MMR --tz Mars/Base', { scope: 'MMR', tz: 'Mars/Base' }),
  artifacts('artifacts -s NOPE', { scope: 'NOPE' }),
  artifacts('artifacts -s mmr', { scope: 'mmr' }),
  // Faults Loom's parser raises.
  artifacts('artifacts -s MMR --bogus', { bogus: true, scope: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argvCase(['artifacts', '-s', 'MMR']),
  argvCase(['artifacts', '-s', 'MMR', '-f', 'json']),
  argvCase(['artifacts', '--scope', 'MMR', '--tag', 'session_summary', '--format', 'ids']),
  argvCase([
    'artifacts',
    '-s',
    'MMR',
    '--after',
    'created_at:2020-01-01',
    '--before',
    'created_at:2999-01-01',
    '-f',
    'ids',
  ]),
  argvCase(['artifacts', '-s', 'MMR', '--offset', '2x', '-f', 'json']),
  argvCase(['artifacts', '-s', 'MMR', '--bogus', '-f', 'json']),
  argvCase(['artifacts', '-s', 'MMR', '--not-before', 'created_at:2020-01-01']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['artifacts', '-s', 'MMR', '-t', 'a', '-t', 'b', '-f', 'ids']),
  argvCase(['artifacts', 'extra', '-s', 'MMR']),
  argvCase(['-s', 'MMR', 'artifacts', '-f', 'ids'], undefined, undefined, ['artifacts']),
  // On a color terminal.
  argvCase(['artifacts', '-s', 'MMR'], true),
  argvCase(['artifacts', '-s', 'MMR', '-f', 'records'], true),
  argvCase(['artifacts', '-s', 'MMR', '-t', 'nothing'], true),
];

parityCases(/^artifacts /, CASES, async (board) => {
  await board.engine.attach({
    content: 'Second body.',
    project: 'MMR',
    summary: 'a session retrospective',
    tags: ['session_summary'],
    title: 'Session notes',
  });
  await board.engine.attach({ content: 'Elsewhere.', project: 'XX', title: 'Other notes' });
  return undefined;
});
