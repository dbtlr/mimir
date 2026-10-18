import { afterAll, beforeAll, expect, test } from 'bun:test';

import { PARITY_DIFFERENCES } from '../parity/differences';
import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { parityProblems, runNew, runOld } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

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
  // Faults Loom's parser raises.
  next('next -s MMR --bogus', { bogus: true, scope: 'MMR' }),
];

test.each(CASES)('parity: $name', async (c) => {
  const old = await runOld(board.store, c);
  const now = await runNew(board.app(c.bound), c);
  expect(parityProblems(board.app(), c, old, now, PARITY_DIFFERENCES)).toEqual([]);
});

test('every next difference entry names a case', () => {
  const names = new Set(CASES.map((c) => c.name));
  const stale = PARITY_DIFFERENCES.filter((d) => d.case.startsWith('next ') && !names.has(d.case));
  expect(stale).toEqual([]);
});
