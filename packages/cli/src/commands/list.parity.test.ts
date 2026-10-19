import { LIST_REDIRECTS } from '../parity/differences';
import { argvCase, argvLine } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const list = (name: string, options: ParityCase['options'] = {}, bound?: string): ParityCase => ({
  name,
  options,
  path: ['list'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // The live set, through every format.
  list('list -s MMR', { scope: 'MMR' }),
  list('list -s MMR -f records', { format: 'records', scope: 'MMR' }),
  list('list -s MMR -f ids', { format: 'ids', scope: 'MMR' }),
  list('list -s MMR -f json', { format: 'json', scope: 'MMR' }),
  list('list -s MMR -f jsonl', { format: 'jsonl', scope: 'MMR' }),
  list('list -s MMR --ascii', { ascii: true, scope: 'MMR' }),
  list('list -s XX -f json', { format: 'json', scope: 'XX' }),
  // The clone binding supplies the project; an explicit -s overrides it.
  list('list (bound to MMR)', {}, 'MMR'),
  list('list (bound to MMR) -f ids', { format: 'ids' }, 'MMR'),
  list('list -s XX (bound to MMR)', { scope: 'XX' }, 'MMR'),
  // The status universe.
  list('list -s MMR --status all', { scope: 'MMR', status: 'all' }),
  list('list -s MMR --status done -f ids', { format: 'ids', scope: 'MMR', status: 'done' }),
  list('list -s MMR --status in_progress', { scope: 'MMR', status: 'in_progress' }),
  list('list -s MMR --status blocked -f json', {
    format: 'json',
    scope: 'MMR',
    status: 'blocked',
  }),
  list('list -s MMR --status ready -f ids', { format: 'ids', scope: 'MMR', status: 'ready' }),
  // Selection.
  list('list -s MMR -p p1', { priority: 'p1', scope: 'MMR' }),
  list('list -s MMR --size small -f ids', { format: 'ids', scope: 'MMR', size: 'small' }),
  list('list -s MMR -q store', { query: 'store', scope: 'MMR' }),
  list('list -s MMR -t alpha -f ids', { format: 'ids', scope: 'MMR', tag: 'alpha' }),
  list('list -s MMR -n 2', { limit: '2', scope: 'MMR' }),
  list('list -s MMR -n 2 -f json', { format: 'json', limit: '2', scope: 'MMR' }),
  list('list -s MMR --is stale -f ids', { format: 'ids', is: ['stale'], scope: 'MMR' }),
  list('list -s MMR --not-is orphaned -f ids', {
    format: 'ids',
    'not-is': ['orphaned'],
    scope: 'MMR',
  }),
  list('list -s MMR --eq type:phase', { eq: ['type:phase'], scope: 'MMR' }),
  list('list -s MMR --not-eq type:task -f ids', {
    format: 'ids',
    'not-eq': ['type:task'],
    scope: 'MMR',
  }),
  list('list -s MMR --in priority:p1,p2 -f json', {
    format: 'json',
    in: ['priority:p1,p2'],
    scope: 'MMR',
  }),
  list('list -s MMR --not-in priority:p1 -f ids', {
    format: 'ids',
    'not-in': ['priority:p1'],
    scope: 'MMR',
  }),
  list('list -s MMR --has summary -f ids', { format: 'ids', has: ['summary'], scope: 'MMR' }),
  list('list -s MMR --missing summary -f ids', {
    format: 'ids',
    missing: ['summary'],
    scope: 'MMR',
  }),
  list('list -s MMR --after created_at:2020-01-01 -f ids', {
    after: ['created_at:2020-01-01'],
    format: 'ids',
    scope: 'MMR',
  }),
  list('list -s MMR --before created_at:2020-01-01 -f json', {
    before: ['created_at:2020-01-01'],
    format: 'json',
    scope: 'MMR',
  }),
  list('list -s MMR --on completed_at:2020-01-01 --tz Asia/Tokyo -f ids', {
    format: 'ids',
    on: ['completed_at:2020-01-01'],
    scope: 'MMR',
    tz: 'Asia/Tokyo',
  }),
  list('list -s MMR --at-or-after created_at:2020-01-01T00:00Z -f ids', {
    'at-or-after': ['created_at:2020-01-01T00:00Z'],
    format: 'ids',
    scope: 'MMR',
  }),
  list('list -s MMR --tz UTC --col lede', { col: ['lede'], scope: 'MMR', tz: 'UTC' }),
  list('list -s MMR --col deps,tags -f json', {
    col: ['deps,tags'],
    format: 'json',
    scope: 'MMR',
  }),
  list('list -s MMR --col lede -f records', { col: ['lede'], format: 'records', scope: 'MMR' }),
  // A value outside a closed vocabulary is an empty set with a warning, not a failure.
  list('list -s MMR --eq priority:p9', { eq: ['priority:p9'], scope: 'MMR' }),
  list('list -s MMR --eq priority:p9 -f json', {
    eq: ['priority:p9'],
    format: 'json',
    scope: 'MMR',
  }),
  // An empty set.
  list('list -s XX -q nothing', { query: 'nothing', scope: 'XX' }),
  list('list -s XX -q nothing -f records', { format: 'records', query: 'nothing', scope: 'XX' }),
  list('list -s XX -q nothing -f ids', { format: 'ids', query: 'nothing', scope: 'XX' }),
  list('list -s XX -q nothing -f json', { format: 'json', query: 'nothing', scope: 'XX' }),
  list('list -s XX -q nothing -f jsonl', { format: 'jsonl', query: 'nothing', scope: 'XX' }),
  // Refusals Mimir raises.
  list('list -s MMR --status bogus', { scope: 'MMR', status: 'bogus' }),
  list('list -s MMR --status archived', { scope: 'MMR', status: 'archived' }),
  list('list -s MMR -p zz', { priority: 'zz', scope: 'MMR' }),
  list('list -s MMR --size huge', { scope: 'MMR', size: 'huge' }),
  list('list -s MMR -n 2x', { limit: '2x', scope: 'MMR' }),
  list('list -s MMR --is bad', { is: ['bad'], scope: 'MMR' }),
  list('list -s MMR --eq bogus:1', { eq: ['bogus:1'], scope: 'MMR' }),
  list('list -s MMR --before title:x', { before: ['title:x'], scope: 'MMR' }),
  list('list -s MMR --tz Mars/Base', { scope: 'MMR', tz: 'Mars/Base' }),
  list('list -s MMR --col bogus', { col: ['bogus'], scope: 'MMR' }),
  list('list -s NOPE', { scope: 'NOPE' }),
  list('list -s mmr', { scope: 'mmr' }),
  // Faults Loom's parser raises.
  list('list -s MMR --bogus', { bogus: true, scope: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argvCase(['list', '-s', 'MMR']),
  argvCase(['list', '-s', 'MMR', '-f', 'json']),
  argvCase(['list', '--scope', 'MMR', '--status', 'done', '--format', 'ids']),
  argvCase(['list', '-s', 'MMR', '--eq', 'priority:p1', '--eq', 'tag:alpha', '-f', 'ids']),
  argvCase(['list', '-s', 'MMR', '-p', 'zz', '-f', 'json']),
  argvCase(['list', '-s', 'MMR', '--bogus', '-f', 'json']),
  // Misplaced and retired flags, each redirected as the old CLI redirected it.
  ...LIST_REDIRECTS.map((line) => argvLine(`list ${line}`)),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['list', '-s', 'MMR', '-p', 'p1', '-p', 'p2', '-f', 'ids']),
  argvCase(['list', 'extra', '-s', 'MMR']),
  argvCase(['-s', 'MMR', 'list', '-f', 'ids'], undefined, undefined, ['list']),
  // On a color terminal.
  argvCase(['list', '-s', 'MMR'], true),
  argvCase(['list', '-s', 'MMR', '-f', 'records'], true),
  argvCase(['list', '-s', 'XX', '-q', 'nothing'], true),
];

parityCases(/^list /, CASES);
