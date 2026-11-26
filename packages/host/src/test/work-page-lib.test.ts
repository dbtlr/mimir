import type { EngineTree } from '@mimir/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { dayOf, buildOutline, newestArtifacts, shippedTime } from '../lib/work-page';
import type { RecordArtifact } from '../lib/work-page';
import { engineTree } from './engine-fixtures';

const NY = 'America/New_York';

describe('dayOf', () => {
  const format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
  afterEach(() => {
    if (format !== undefined) {
      Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', format);
    }
  });

  it('keys a day YYYY-MM-DD in the zone, whatever pattern a locale formats whole dates in', () => {
    // ICU has shipped en-CA with a slashed pattern; the key must not follow it.
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', {
      configurable: true,
      get: () => () => '11/23/2026',
    });
    const at = Date.parse('2026-11-24T03:30:00Z');
    expect(dayOf(at, 'America/New_York')).toBe('2026-11-23');
    expect(dayOf(at, 'UTC')).toBe('2026-11-24');
  });
});

describe('shippedTime', () => {
  it('reads the finish as a 24-hour HH:MM in the zone', () => {
    expect(shippedTime(new Date('2026-10-12T14:05:00.000Z'), NY)).toBe('10:05');
    expect(shippedTime(new Date('2026-10-13T04:00:00.000Z'), NY)).toBe('00:00');
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

  it('folds finished top-level initiatives apart from the live outline, each with its own subtree', () => {
    const { finished } = buildOutline(
      tn('MMR', 'project', 'in_progress', [
        tn('MMR-1', 'initiative', 'done', [
          tn('MMR-2', 'phase', 'done', [tn('MMR-3', 'phase', 'done')]),
          tn('MMR-4', 'phase', 'done'),
        ]),
        tn('MMR-5', 'initiative', 'ready'),
        tn('MMR-6', 'initiative', 'abandoned', [tn('MMR-7', 'task', 'abandoned')]),
      ]),
    );

    expect(
      finished.map((f) => [f.row.id, f.row.depth, f.inside.map((e) => [e.id, e.depth])]),
    ).toStrictEqual([
      [
        'MMR-1',
        0,
        [
          ['MMR-2', 1],
          ['MMR-3', 2],
          ['MMR-4', 1],
        ],
      ],
      ['MMR-6', 0, []],
    ]);
  });

  it('holds no finished initiative open when no record is open', () => {
    expect(buildOutline(tree).finished.map((f) => f.holdsOpen)).toStrictEqual([false]);
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

    expect(outline.finished[0]?.row.tally).toStrictEqual({ done: 1, kind: 'counts', total: 1 });
  });

  it('is empty for a project that holds only tasks', () => {
    const outline = buildOutline(tn('MMR', 'project', 'ready', [tn('MMR-1', 'task', 'ready')]));

    expect(outline.entries).toStrictEqual([]);
    expect(outline.finished).toStrictEqual([]);
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

  it('puts a task under a finished initiative in that initiative’s fold, held open', () => {
    const { entries, finished } = buildOutline(tree, 'MMR-7');

    expect(entries.some((e) => e.id === 'MMR-7')).toBe(false);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.row.mark).toBe('path');
    expect(finished[0]?.holdsOpen).toBe(true);
    expect(finished[0]?.inside.map((e) => [e.id, e.mark])).toStrictEqual([
      ['MMR-6', 'path'],
      ['MMR-7', 'current'],
    ]);
  });

  it('holds a finished initiative open when it is the open record', () => {
    expect(buildOutline(tree, 'MMR-5').finished[0]?.holdsOpen).toBe(true);
  });

  it('lists a task held directly by a finished initiative inside its fold', () => {
    const { finished } = buildOutline(
      tn('MMR', 'project', 'in_progress', [
        tn('MMR-1', 'initiative', 'done', [
          tn('MMR-2', 'phase', 'done'),
          tn('MMR-3', 'task', 'done'),
        ]),
      ]),
      'MMR-3',
    );

    expect(finished[0]?.inside.map((e) => [e.id, e.depth, e.mark])).toStrictEqual([
      ['MMR-3', 1, 'current'],
      ['MMR-2', 1, undefined],
    ]);
  });

  it('holds open only the finished initiative the open record sits in', () => {
    const { finished } = buildOutline(
      tn('MMR', 'project', 'in_progress', [
        tn('MMR-1', 'initiative', 'done', [tn('MMR-2', 'phase', 'done')]),
        tn('MMR-3', 'initiative', 'done', [tn('MMR-4', 'phase', 'done')]),
        tn('MMR-5', 'initiative', 'done', [tn('MMR-6', 'phase', 'done')]),
      ]),
      'MMR-4',
    );

    expect(finished.map((f) => [f.row.id, f.holdsOpen])).toStrictEqual([
      ['MMR-1', false],
      ['MMR-3', true],
      ['MMR-5', false],
    ]);
  });

  it('keeps a finished initiative shut when the open record is outside it', () => {
    expect(buildOutline(tree, 'MMR-2').finished[0]?.holdsOpen).toBe(false);
  });

  it('marks nothing for an id the tree does not hold', () => {
    expect(buildOutline(tree, 'MMR-99').entries.every((e) => e.mark === undefined)).toBe(true);
  });
});

const artifact = (id: string, createdAt: string): RecordArtifact => ({
  createdAt: new Date(createdAt),
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
