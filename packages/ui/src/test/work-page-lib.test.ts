import { describe, expect, it } from 'vitest';

import type { WireArtifact, WireTreeNode } from '../api/types';
import {
  SHIPPED_DAY_CAP,
  buildOutline,
  capDay,
  frontierIsEmpty,
  groupShippedByDay,
  newestArtifacts,
  shippedTime,
} from '../lib/work-page';

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
  type: WireTreeNode['type'],
  status: WireTreeNode['status'],
  children: WireTreeNode[] = [],
  extra: Partial<WireTreeNode> = {},
): WireTreeNode {
  return {
    children,
    created_at: '2026-06-01T10:00:00.000Z',
    id,
    parent: null,
    status,
    title: id,
    type,
    updated_at: '2026-06-01T10:00:00.000Z',
    ...extra,
  };
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

  it('counts the project’s direct children done over total, tasks included', () => {
    expect(buildOutline(tree).root).toStrictEqual({ done: 1, total: 5 });
  });

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
    expect(outline.root).toStrictEqual({ done: 1, total: 1 });
  });

  it('is empty for a project that holds only tasks', () => {
    const outline = buildOutline(tn('MMR', 'project', 'ready', [tn('MMR-1', 'task', 'ready')]));

    expect(outline.entries).toStrictEqual([]);
    expect(outline.finished).toStrictEqual({ count: 0, entries: [] });
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
});
