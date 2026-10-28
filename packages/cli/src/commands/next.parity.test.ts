import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const next = (name: string, options: ParityCase['options'] = {}, bound?: string): ParityCase => ({
  name,
  options,
  path: ['next'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // The ready set, through every format.
  next('next -s MMR', { scope: 'MMR' }),
  next('next -s MMR -f records', { format: 'records', scope: 'MMR' }),
  next('next -s MMR -f ids', { format: 'ids', scope: 'MMR' }),
  next('next -s MMR -f json', { format: 'json', scope: 'MMR' }),
  next('next -s MMR -f jsonl', { format: 'jsonl', scope: 'MMR' }),
  next('next -s MMR --ascii', { ascii: true, scope: 'MMR' }),
  // The clone binding supplies the project; an explicit -s overrides it.
  next('next (bound to MMR)', {}, 'MMR'),
  next('next (bound to MMR) -f json', { format: 'json' }, 'MMR'),
  next('next -s XX (bound to MMR)', { scope: 'XX' }, 'MMR'),
  // Selection.
  next('next -s MMR -p p1', { priority: 'p1', scope: 'MMR' }),
  next('next -s MMR --size s', { scope: 'MMR', size: 's' }),
  next('next -s MMR --size small -f ids', { format: 'ids', scope: 'MMR', size: 'small' }),
  next('next -s MMR -q store', { query: 'store', scope: 'MMR' }),
  next('next -s MMR -q mmr-8 -f ids', { format: 'ids', query: 'mmr-8', scope: 'MMR' }),
  next('next -s MMR -n 1', { limit: '1', scope: 'MMR' }),
  next('next -s MMR -n 1 -f json', { format: 'json', limit: '1', scope: 'MMR' }),
  next('next -s MMR -n 0 -f json', { format: 'json', limit: '0', scope: 'MMR' }),
  next('next -s MMR --is stale -f ids', { format: 'ids', is: ['stale'], scope: 'MMR' }),
  next('next -s MMR --not-is orphaned', { 'not-is': ['orphaned'], scope: 'MMR' }),
  next('next -s MMR --eq priority:p1 -f ids', { eq: ['priority:p1'], format: 'ids', scope: 'MMR' }),
  next('next -s MMR --not-eq priority:p1 -f ids', {
    format: 'ids',
    'not-eq': ['priority:p1'],
    scope: 'MMR',
  }),
  next('next -s MMR --in priority:p1,p2 -f json', {
    format: 'json',
    in: ['priority:p1,p2'],
    scope: 'MMR',
  }),
  next('next -s MMR --not-in priority:p1 -f ids', {
    format: 'ids',
    'not-in': ['priority:p1'],
    scope: 'MMR',
  }),
  next('next -s MMR --has summary -f ids', { format: 'ids', has: ['summary'], scope: 'MMR' }),
  next('next -s MMR --missing summary -f ids', {
    format: 'ids',
    missing: ['summary'],
    scope: 'MMR',
  }),
  next('next -s MMR --eq tag:alpha', { eq: ['tag:alpha'], scope: 'MMR' }),
  next('next -s MMR --after created_at:2020-01-01 -f ids', {
    after: ['created_at:2020-01-01'],
    format: 'ids',
    scope: 'MMR',
  }),
  next('next -s MMR --before created_at:2020-01-01 -f json', {
    before: ['created_at:2020-01-01'],
    format: 'json',
    scope: 'MMR',
  }),
  next('next -s MMR --on created_at:2020-01-01 --tz Asia/Tokyo -f ids', {
    format: 'ids',
    on: ['created_at:2020-01-01'],
    scope: 'MMR',
    tz: 'Asia/Tokyo',
  }),
  next('next -s MMR --at-or-after created_at:2020-01-01T00:00Z -f ids', {
    'at-or-after': ['created_at:2020-01-01T00:00Z'],
    format: 'ids',
    scope: 'MMR',
  }),
  next('next -s MMR --at-or-before created_at:2020-01-01T00:00Z -f ids', {
    'at-or-before': ['created_at:2020-01-01T00:00Z'],
    format: 'ids',
    scope: 'MMR',
  }),
  next('next -s MMR --tz UTC --col lede', { col: ['lede'], scope: 'MMR', tz: 'UTC' }),
  next('next -s MMR --col deps,tags -f json', { col: ['deps,tags'], format: 'json', scope: 'MMR' }),
  next('next -s MMR --col lede -f records', { col: ['lede'], format: 'records', scope: 'MMR' }),
  // A value outside a closed vocabulary is an empty set with a warning, not a failure.
  next('next -s MMR --eq priority:p9', { eq: ['priority:p9'], scope: 'MMR' }),
  next('next -s MMR --eq priority:p9 -f json', {
    eq: ['priority:p9'],
    format: 'json',
    scope: 'MMR',
  }),
  // An empty set.
  next('next -s XX -p p0', { priority: 'p0', scope: 'XX' }),
  next('next -s XX -p p0 -f records', { format: 'records', priority: 'p0', scope: 'XX' }),
  next('next -s XX -p p0 -f ids', { format: 'ids', priority: 'p0', scope: 'XX' }),
  next('next -s XX -p p0 -f json', { format: 'json', priority: 'p0', scope: 'XX' }),
  next('next -s XX -p p0 -f jsonl', { format: 'jsonl', priority: 'p0', scope: 'XX' }),
  // Refusals Mimir raises.
  next('next -s MMR -p zz', { priority: 'zz', scope: 'MMR' }),
  next('next -s MMR --size huge', { scope: 'MMR', size: 'huge' }),
  next('next -s MMR -n 2x', { limit: '2x', scope: 'MMR' }),
  next('next -s MMR --is bad', { is: ['bad'], scope: 'MMR' }),
  next('next -s MMR --eq bogus:1', { eq: ['bogus:1'], scope: 'MMR' }),
  next('next -s MMR --eq priority', { eq: ['priority'], scope: 'MMR' }),
  next('next -s MMR --eq created_at:2020-01-01', { eq: ['created_at:2020-01-01'], scope: 'MMR' }),
  next('next -s MMR --before title:x', { before: ['title:x'], scope: 'MMR' }),
  next('next -s MMR --after created_at:someday', { after: ['created_at:someday'], scope: 'MMR' }),
  next('next -s MMR --tz Mars/Base', { scope: 'MMR', tz: 'Mars/Base' }),
  next('next -s MMR --col bogus', { col: ['bogus'], scope: 'MMR' }),
  next('next -s NOPE', { scope: 'NOPE' }),
  // A scope not shaped like a key is a missing project, not a schema fault.
  next('next -s mmr', { scope: 'mmr' }),
  next('next -s XX-1', { scope: 'XX-1' }),
  next('next -s A -f json', { format: 'json', scope: 'A' }),
  next('next -s ABCDEFGHIJKLMNOP', { scope: 'ABCDEFGHIJKLMNOP' }),
  next('next -s ""', { scope: '' }),
  // Faults Loom's parser raises.
  next('next -s MMR --bogus', { bogus: true, scope: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argvCase(['next', '-s', 'MMR']),
  argvCase(['next', '-s', 'MMR', '-f', 'json']),
  argvCase(['next', '--scope', 'MMR', '--priority', 'p1', '--format', 'ids']),
  argvCase(['next', '-s', 'MMR', '--eq', 'priority:p1', '--eq', 'tag:alpha', '-f', 'ids']),
  argvCase(['next', '-s', 'MMR', '-p', 'zz']),
  argvCase(['next', '-s', 'MMR', '-p', 'zz', '-f', 'json']),
  argvCase(['next', '-s', 'mmr']),
  argvCase(['next', '-s', 'MMR', '--bogus', '-f', 'json']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['next', '-s', 'MMR', '-p', 'p1', '-p', 'p2', '-f', 'ids']),
  argvCase(['next', '-s', 'MMR', '--ascii', '--ascii']),
  argvCase(['next', 'extra', '-s', 'MMR']),
  argvCase(['-s', 'MMR', 'next', '-f', 'ids'], undefined, undefined, ['next']),
  // On a color terminal.
  argvCase(['next', '-s', 'MMR'], true),
  argvCase(['next', '-s', 'MMR', '-f', 'records'], true),
  argvCase(['next', '-s', 'XX', '-p', 'p0'], true),
  argvCase(['next', '-s', 'MMR', '--ascii'], true),
];

parityCases(import.meta.url, CASES);
