import type { EngineTree } from '@mimir/contract';
import { describe, expect, it } from 'vitest';

import type { WireArtifact } from '../api/types';
import {
  SHIPPED_DAY_CAP,
  buildOutline,
  capDay,
  frontierIsEmpty,
  groupShippedByDay,
  newestArtifacts,
  shippedTime,
} from '../lib/work-page';
import { engineTree } from './engine-fixtures';

// Mon Oct 12 2026, 23:30 in New York (03:30 UTC on the 13th).
const NOW = Date.parse('2026-10-13T03:30:00.000Z');
const NY = 'America/New_York';

const shipped = (id: string, at: string) => ({ finished_at: at, id });

describe('groupShippedByDay', () => {
  it('groups by calendar day in the given zone, newest day first, labelled Today and Yesterday', () => {
    const groups = groupShippedByDay(
      [
        shipped('MMR-1', '2026-10-13T03:00:00.000Z'), // Oct 12, 23:00 NY
        shipped('MMR-2', '2026-10-12T14:00:00.000Z'), // Oct 12, 10:00 NY
        shipped('MMR-3', '2026-10-12T03:00:00.000Z'), // Oct 11, 23:00 NY
        shipped('MMR-4', '2026-10-10T20:00:00.000Z'), // Oct 10, 16:00 NY
      ],
      NY,
      NOW,
    );

    expect(groups.map((g) => g.label)).toStrictEqual([
      'Today · Mon Oct 12',
      'Yesterday · Sun Oct 11',
      'Sat Oct 10',
    ]);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toStrictEqual([
      ['MMR-1', 'MMR-2'],
      ['MMR-3'],
      ['MMR-4'],
    ]);
  });

  it('puts the same instant on a different day in a different zone', () => {
    const rows = [shipped('MMR-1', '2026-10-13T03:00:00.000Z')];

    expect(groupShippedByDay(rows, 'UTC', NOW).map((g) => g.label)).toStrictEqual([
      'Today · Tue Oct 13',
    ]);
    expect(groupShippedByDay(rows, NY, NOW).map((g) => g.label)).toStrictEqual([
      'Today · Mon Oct 12',
    ]);
  });

  it('orders rows newest first within a day even when served out of order', () => {
    const [today] = groupShippedByDay(
      [shipped('MMR-1', '2026-10-12T14:00:00.000Z'), shipped('MMR-2', '2026-10-12T18:00:00.000Z')],
      NY,
      NOW,
    );

    expect(today?.rows.map((r) => r.id)).toStrictEqual(['MMR-2', 'MMR-1']);
  });

  it('is empty when nothing shipped', () => {
    expect(groupShippedByDay([], NY, NOW)).toStrictEqual([]);
  });
});

describe('shippedTime', () => {
  it('reads the finish as a 24-hour HH:MM in the zone', () => {
    expect(shippedTime('2026-10-12T14:05:00.000Z', NY)).toBe('10:05');
    expect(shippedTime('2026-10-13T04:00:00.000Z', NY)).toBe('00:00');
  });
});

describe('capDay', () => {
  const rows = [1, 2, 3, 4, 5];

  it('shows the first rows of a day and counts the rest', () => {
    expect(SHIPPED_DAY_CAP).toBe(3);
    expect(capDay(rows, false)).toStrictEqual({ hidden: 2, shown: [1, 2, 3] });
  });

  it('shows every row once the day is expanded', () => {
    expect(capDay(rows, true)).toStrictEqual({ hidden: 0, shown: rows });
  });

  it('caps at the width a list asks for', () => {
    expect(capDay(rows, false, 4)).toStrictEqual({ hidden: 1, shown: [1, 2, 3, 4] });
  });

  it('hides nothing on a day within the cap', () => {
    expect(capDay([1, 2, 3], false)).toStrictEqual({ hidden: 0, shown: [1, 2, 3] });
  });
});

describe('frontierIsEmpty', () => {
  const empty = { next_to_unlock: [], runnable: [], to_groom: [], waiting_on_others: [] };

  it('is true when every list is empty', () => {
    expect(frontierIsEmpty(empty)).toBe(true);
  });

  it.each([
    ['runnable', { runnable: [1] }],
    ['to_groom', { to_groom: [1] }],
    ['waiting_on_others', { waiting_on_others: [1] }],
    ['next_to_unlock', { next_to_unlock: [{ tasks: [1] }] }],
  ])('is false when %s holds a row', (_list, rows) => {
    expect(frontierIsEmpty({ ...empty, ...rows })).toBe(false);
  });
});

function tn(
  id: string,
  type: EngineTree['type'],
  status: EngineTree['status'],
  children: EngineTree[] = [],
  extra: Partial<EngineTree> = {},
): EngineTree {
  return engineTree({ id, status, title: id, type, ...extra }, children);
}

describe('buildOutline', () => {
  const tree = tn('MMR', 'project', 'in_progress', [
    tn('MMR-1', 'initiative', 'in_progress', [
      tn('MMR-2', 'phase', 'done', [tn('MMR-3', 'task', 'done'), tn('MMR-4', 'task', 'done')]),
      tn('MMR-5', 'phase', 'in_progress', [
        tn('MMR-6', 'task', 'done'),
        tn('MMR-7', 'task', 'ready'),
      ]),
    ]),
    tn('MMR-8', 'initiative', 'done', [
      tn('MMR-9', 'phase', 'done', [tn('MMR-10', 'task', 'done')]),
    ]),
    tn('MMR-11', 'initiative', 'ready', [], { open_ended: true }),
    tn('MMR-12', 'initiative', 'parked', [tn('MMR-13', 'task', 'parked')]),
    tn('MMR-14', 'task', 'ready'),
  ]);

  it('lists live initiatives and phases with depth, leaving tasks out', () => {
    expect(buildOutline(tree).entries.map((e) => [e.id, e.depth])).toStrictEqual([
      ['MMR-1', 0],
      ['MMR-2', 1],
      ['MMR-5', 1],
      ['MMR-11', 0],
      ['MMR-12', 0],
    ]);
  });

  it('tallies each container by its direct children, ∞ when open-ended and parked when parked', () => {
    const tallies = Object.fromEntries(buildOutline(tree).entries.map((e) => [e.id, e.tally]));

    expect(tallies['MMR-1']).toStrictEqual({ done: 1, kind: 'counts', total: 2 });
    expect(tallies['MMR-5']).toStrictEqual({ done: 1, kind: 'counts', total: 2 });
    expect(tallies['MMR-11']).toStrictEqual({ kind: 'open_ended' });
    expect(tallies['MMR-12']).toStrictEqual({ kind: 'parked' });
  });

  it('folds finished top-level initiatives, with their subtrees, apart from the live outline', () => {
    const { finished } = buildOutline(tree);

    expect(finished.count).toBe(1);
    expect(finished.entries.map((e) => [e.id, e.depth])).toStrictEqual([
      ['MMR-8', 0],
      ['MMR-9', 1],
    ]);
  });

  it('keeps a finished phase in place under a live initiative', () => {
    expect(buildOutline(tree).entries.some((e) => e.id === 'MMR-2')).toBe(true);
  });

  it('leaves abandoned children out of the total, so a finished container reads N/N', () => {
    const outline = buildOutline(
      tn('MMR', 'project', 'in_progress', [
        tn('MMR-1', 'initiative', 'done', [
          tn('MMR-2', 'task', 'done'),
          tn('MMR-3', 'task', 'abandoned'),
        ]),
      ]),
    );

    expect(outline.finished.entries[0]?.tally).toStrictEqual({ done: 1, kind: 'counts', total: 1 });
  });

  it('is empty for a project that holds only tasks', () => {
    const outline = buildOutline(tn('MMR', 'project', 'ready', [tn('MMR-1', 'task', 'ready')]));

    expect(outline.entries).toStrictEqual([]);
    expect(outline.finished).toStrictEqual({ count: 0, entries: [] });
  });
});

/** Each row's id and mark. */
const marks = (entries: ReturnType<typeof buildOutline>['entries']) =>
  entries.map((e) => [e.id, e.mark]);

describe('buildOutline marks the open record’s place', () => {
  const tree = tn('MMR', 'project', 'in_progress', [
    tn('MMR-1', 'initiative', 'in_progress', [
      tn('MMR-2', 'phase', 'in_progress', [tn('MMR-3', 'task', 'blocked')]),
      tn('MMR-4', 'phase', 'ready'),
    ]),
    tn('MMR-5', 'initiative', 'done', [
      tn('MMR-6', 'phase', 'done', [tn('MMR-7', 'task', 'done')]),
    ]),
    tn('MMR-8', 'task', 'ready'),
  ]);

  it('marks nothing when no record is open', () => {
    expect(buildOutline(tree).entries.every((e) => e.mark === undefined)).toBe(true);
  });

  it('marks a container current and the containers above it as its path', () => {
    expect(marks(buildOutline(tree, 'MMR-2').entries)).toStrictEqual([
      ['MMR-1', 'path'],
      ['MMR-2', 'current'],
      ['MMR-4', undefined],
    ]);
  });

  it('marks a task’s containers as its path and lists the task under its nearest container', () => {
    const { entries } = buildOutline(tree, 'MMR-3');

    expect(entries.map((e) => [e.id, e.mark, e.depth])).toStrictEqual([
      ['MMR-1', 'path', 0],
      ['MMR-2', 'path', 1],
      ['MMR-3', 'current', 2],
      ['MMR-4', undefined, 1],
    ]);
    expect(entries[2]).toMatchObject({ status: 'blocked', tally: { kind: 'none' } });
  });

  it('lists a task of the project itself first, at the top level', () => {
    expect(buildOutline(tree, 'MMR-8').entries[0]).toMatchObject({
      depth: 0,
      id: 'MMR-8',
      mark: 'current',
    });
  });

  it('puts a task under a finished initiative in the fold', () => {
    const { entries, finished } = buildOutline(tree, 'MMR-7');

    expect(entries.some((e) => e.id === 'MMR-7')).toBe(false);
    expect(finished.entries.map((e) => [e.id, e.mark])).toStrictEqual([
      ['MMR-5', 'path'],
      ['MMR-6', 'path'],
      ['MMR-7', 'current'],
    ]);
  });

  it('marks nothing for an id the tree does not hold', () => {
    expect(buildOutline(tree, 'MMR-99').entries.every((e) => e.mark === undefined)).toBe(true);
  });
});

const artifact = (id: string, created_at: string): WireArtifact => ({
  created_at,
  id,
  tags: [],
  title: id,
});

describe('newestArtifacts', () => {
  it('orders newest first, takes the limit, and leaves the input alone', () => {
    const input = [
      artifact('a', '2026-06-01T10:00:00.000Z'),
      artifact('c', '2026-06-03T10:00:00.000Z'),
      artifact('b', '2026-06-02T10:00:00.000Z'),
    ];

    expect(newestArtifacts(input, 2).map((a) => a.id)).toStrictEqual(['c', 'b']);
    expect(input.map((a) => a.id)).toStrictEqual(['a', 'c', 'b']);
  });

  it('breaks equal timestamps on the higher artifact seq, as the server list does', () => {
    const at = '2026-06-01T10:00:00.000Z';
    const input = [artifact('MMR-a2', at), artifact('MMR-a10', at), artifact('MMR-a9', at)];

    expect(newestArtifacts(input, 3).map((a) => a.id)).toStrictEqual([
      'MMR-a10',
      'MMR-a9',
      'MMR-a2',
    ]);
  });
});
