import type { EngineTree } from '@mimir/contract';
import { describe, expect, it } from 'vitest';

import { needsYouCards } from '../components/needs-you-deck-model';
import {
  containerHasWork,
  lastFinishedAt,
  latestMoveFirst,
  partsOf,
  quietSentence,
  scopeCards,
  scopedMinuteRows,
  shippedSplit,
  upNext,
} from '../lib/scoped-work';
import { engineTree } from './engine-fixtures';
import { blocked, decision, question, report, stopped } from './needs-you-fixtures';
import { engineContainer } from './node-fixtures';
import { engineWork, frontierRow, nowRow, shippedRow } from './views-fixtures';

/*
 * A project's, initiative's, or phase's Work tab on Home's pattern (ADR 0013,
 * MMR-727 refinement): the deck kept to the scope, Now's order, Up next and
 * its unlocks row, Shipped split one level down, the spare-minute rows per
 * scope, the parts and their finished fold, the quiet sentence, and when an
 * initiative or phase has Work at all.
 */

// Thursday 26 November 2026, 15:00 in New York.
const NOW = Date.parse('2026-11-26T20:00:00.000Z');
const ZONE = 'America/New_York';
/** Noon in New York, `d` days before the 26th. */
const daysAgo = (d: number) =>
  new Date(Date.parse(`2026-11-${String(26 - d).padStart(2, '0')}T12:00:00-05:00`));

const task = (id: string, status: EngineTree['status'], extra: Partial<EngineTree> = {}) =>
  engineTree({ id, status, title: `Task ${id}`, type: 'task', ...extra });
const phase = (id: string, status: EngineTree['status'], children: EngineTree[], title = id) =>
  engineTree({ id, status, title, type: 'phase' }, children);
const initiative = (id: string, status: EngineTree['status'], children: EngineTree[], title = id) =>
  engineTree({ id, status, title, type: 'initiative' }, children);

/** A Mimir project holding `children`. */
const projectWith = (children: EngineTree[]) =>
  engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, children);

/**
 * Mimir's tree: a live initiative with a finished and a live phase and a task
 * directly under it, and a finished initiative.
 */
const TREE = projectWith([
  initiative(
    'MMR-1',
    'in_progress',
    [
      phase(
        'MMR-2',
        'done',
        [
          task('MMR-3', 'done', { completedAt: daysAgo(12) }),
          task('MMR-4', 'done', { completedAt: daysAgo(9) }),
        ],
        'Phase 1',
      ),
      phase(
        'MMR-5',
        'in_progress',
        [
          task('MMR-6', 'done', { completedAt: daysAgo(1) }),
          task('MMR-7', 'ready'),
          task('MMR-8', 'abandoned'),
        ],
        'Phase 2',
      ),
      task('MMR-9', 'done', { completedAt: daysAgo(2) }),
    ],
    'Console work',
  ),
  initiative(
    'MMR-10',
    'abandoned',
    [phase('MMR-11', 'abandoned', [task('MMR-12', 'abandoned')], 'Old phase')],
    'Old arc',
  ),
  initiative('MMR-13', 'ready', [phase('MMR-14', 'ready', [], 'Empty phase')], 'Next arc'),
]);

describe('the scoped Needs you deck', () => {
  const all = needsYouCards(
    report([
      question('MMR-20'),
      decision('MMR-q1', { delivery: 'MMR-d1' }),
      decision('MMR-q2', { delivery: 'MMR-d1' }),
      stopped('MMR-d2'),
      blocked('FLT-5'),
    ]),
  );

  it('keeps the cards that hold a record in the scope’s needs-you set, in the set’s order', () => {
    expect(scopeCards(all, ['FLT-5', 'MMR-20']).map((card) => card.key)).toStrictEqual([
      'MMR-20',
      'FLT-5',
    ]);
  });

  it('shows a bundle whole, with its full count, when one of its decisions is in scope', () => {
    const [bundle] = scopeCards(all, ['MMR-q2']);
    expect(bundle?.id).toBe('MMR-d1');
    expect(bundle?.records).toBe(2);
  });

  it('keeps a stopped delivery in scope by its own ID', () => {
    expect(scopeCards(all, ['MMR-d2']).map((card) => card.key)).toStrictEqual(['MMR-d2']);
  });

  it('keeps nothing when nothing in scope needs you', () => {
    expect(scopeCards(all, [])).toStrictEqual([]);
  });
});

describe('Now’s order', () => {
  it('puts the most recent move first: a review’s or a stage’s submit, else the start', () => {
    const rows = [
      nowRow({ id: 'MMR-1' }, { startedAt: daysAgo(3) }),
      nowRow(
        { id: 'MMR-2', status: 'under_review' },
        { startedAt: daysAgo(5), submittedAt: daysAgo(1) },
      ),
      nowRow({ id: 'MMR-3' }, { startedAt: daysAgo(2) }),
    ];
    expect(latestMoveFirst(rows).map((row) => row.task.id)).toStrictEqual([
      'MMR-2',
      'MMR-3',
      'MMR-1',
    ]);
  });
});

const ready = (id: string, awaitingOn: string[] = []) =>
  frontierRow({ grooming: 'groomed', id, status: 'ready' }, { awaitingOn });
const frontier = (parts: Partial<ReturnType<typeof engineWork>['frontier']>) => ({
  ...engineWork().frontier,
  ...parts,
});

describe('Up next', () => {
  it('shows three of the tasks that can start, and counts them all', () => {
    const next = upNext(
      frontier({ runnable: ['MMR-1', 'MMR-2', 'MMR-3', 'MMR-4'].map((id) => ready(id)) }),
    );
    expect(next.cards.map((row) => row.task.id)).toStrictEqual(['MMR-1', 'MMR-2', 'MMR-3']);
    expect(next.total).toBe(4);
  });

  it('names the first prerequisite, in board order, that a task waits on alone, with how many', () => {
    const next = upNext(
      frontier({
        nextToUnlock: [
          // Every task here also waits on something else.
          {
            prerequisite: { id: 'MMR-7' },
            tasks: [ready('MMR-20', ['MMR-7', 'MMR-8'])],
          },
          {
            prerequisite: { id: 'MMR-8' },
            tasks: [
              ready('MMR-20', ['MMR-7', 'MMR-8']),
              ready('MMR-21', ['MMR-8']),
              ready('MMR-22', ['MMR-8']),
            ],
          },
          { prerequisite: { id: 'MMR-9' }, tasks: [ready('MMR-23', ['MMR-9'])] },
        ],
      }),
    );
    expect(next.unlocks).toStrictEqual({ count: 2, id: 'MMR-8' });
  });

  it('has no unlocks row when no task waits on one prerequisite alone', () => {
    const next = upNext(
      frontier({
        nextToUnlock: [
          { prerequisite: { id: 'MMR-7' }, tasks: [ready('MMR-20', ['MMR-7', 'MMR-8'])] },
        ],
      }),
    );
    expect(next.unlocks).toBeUndefined();
    expect(next.total).toBe(0);
  });
});

describe('Shipped this week, split one level down', () => {
  // Each task's parent is a phase or the initiative that holds it directly.
  const rows = [
    shippedRow({ id: 'MMR-6', parent: 'MMR-5' }, daysAgo(1)),
    shippedRow({ id: 'MMR-9', parent: 'MMR-1' }, daysAgo(2)),
    shippedRow({ id: 'MMR-15', parent: 'MMR-16' }, daysAgo(0)),
    shippedRow({ id: 'MMR-8', parent: 'MMR-5', status: 'abandoned' }, daysAgo(0)),
    // Outside the seven days ending today.
    shippedRow({ id: 'MMR-4', parent: 'MMR-2' }, daysAgo(9)),
  ];
  const withNewPhase = projectWith([
    initiative(
      'MMR-1',
      'in_progress',
      [
        ...(TREE.children[0]?.children ?? []),
        phase('MMR-16', 'in_progress', [task('MMR-15', 'done')], 'Phase 3'),
      ],
      'Console work',
    ),
  ]);
  const project = { id: 'MMR', kind: 'project', title: 'Mimir' } as const;

  it('splits a project’s by phase, a task directly under an initiative under that initiative', () => {
    const split = shippedSplit({ now: NOW, rows, scope: project, tree: withNewPhase, zone: ZONE });
    expect(split.total).toBe(3);
    expect(split.days.map((day) => day.count)).toStrictEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(split.breakdown).toStrictEqual({
      kind: 'parts',
      rows: [
        // One each: tree order, a container before what it holds, breaks the tie.
        { count: 1, id: 'MMR-1', name: 'Console work' },
        { count: 1, id: 'MMR-5', name: 'Phase 2' },
        { count: 1, id: 'MMR-16', name: 'Phase 3' },
      ],
    });
  });

  it('counts most first', () => {
    const split = shippedSplit({
      now: NOW,
      rows: [...rows, shippedRow({ id: 'MMR-17', parent: 'MMR-16' }, daysAgo(1))],
      scope: project,
      tree: withNewPhase,
      zone: ZONE,
    });
    expect(split.breakdown.kind === 'parts' && split.breakdown.rows[0]).toStrictEqual({
      count: 2,
      id: 'MMR-16',
      name: 'Phase 3',
    });
  });

  it('names a container the tree has not read by its ID', () => {
    const split = shippedSplit({ now: NOW, rows, scope: project, tree: undefined, zone: ZONE });
    expect(
      split.breakdown.kind === 'parts' && split.breakdown.rows.map((row) => row.name),
    ).toStrictEqual(['MMR-1', 'MMR-16', 'MMR-5']);
  });

  it('splits an initiative’s by phase, its direct tasks under its own title', () => {
    const split = shippedSplit({
      now: NOW,
      rows: [...rows, shippedRow({ id: 'MMR-18', parent: 'MMR-5' }, daysAgo(3))],
      scope: { id: 'MMR-1', kind: 'initiative', title: 'Console work' },
      tree: withNewPhase,
      zone: ZONE,
    });
    expect(split.breakdown).toStrictEqual({
      kind: 'parts',
      rows: [
        { count: 2, id: 'MMR-5', name: 'Phase 2' },
        { count: 1, id: 'MMR-1', name: 'Console work' },
        { count: 1, id: 'MMR-16', name: 'Phase 3' },
      ],
    });
  });

  it('lists a phase’s done tasks themselves, most recent first, three at most', () => {
    const split = shippedSplit({
      now: NOW,
      rows: [
        shippedRow({ id: 'MMR-31' }, daysAgo(3)),
        shippedRow({ id: 'MMR-32' }, daysAgo(0)),
        shippedRow({ id: 'MMR-33', status: 'abandoned' }, daysAgo(0)),
        shippedRow({ id: 'MMR-34' }, daysAgo(1)),
        shippedRow({ id: 'MMR-35' }, daysAgo(2)),
      ],
      scope: { id: 'MMR-5', kind: 'phase', title: 'Phase 2' },
      tree: TREE,
      zone: ZONE,
    });
    expect(split.total).toBe(4);
    expect(
      split.breakdown.kind === 'tasks' && split.breakdown.rows.map((row) => row.task.id),
    ).toStrictEqual(['MMR-32', 'MMR-34', 'MMR-35']);
  });
});

describe('When you have a minute, per scope', () => {
  const work = engineWork({
    frontier: frontier({
      toGroom: [frontierRow({ id: 'MMR-40', status: 'ready' })],
      waitingOnOthers: [],
    }),
    goingCold: [engineContainer({ id: 'MMR-41', status: 'ready', type: 'phase' })],
  });

  it('counts a project’s To groom, Seeds to triage, Going cold, Waiting on others, and Record health, with their doors', () => {
    expect(
      scopedMinuteRows({ findings: 4, kind: 'project', project: 'MMR', untriaged: 5, work }),
    ).toStrictEqual([
      { count: 1, name: 'To groom' },
      {
        count: 5,
        door: { list: 'seeds', project: 'MMR', show: 'to-triage' },
        name: 'Seeds to triage',
      },
      { count: 1, door: { list: 'tasks', project: 'MMR', show: 'going-cold' }, name: 'Going cold' },
      { count: 0, name: 'Waiting on others' },
      { count: 4, door: { list: 'doctor', project: 'MMR' }, name: 'Record health findings' },
    ]);
  });

  it('leaves seeds and Record health off an initiative or phase, and gives it no doors', () => {
    expect(
      scopedMinuteRows({ findings: 4, kind: 'phase', project: 'MMR', untriaged: 5, work }),
    ).toStrictEqual([
      { count: 1, name: 'To groom' },
      { count: 1, name: 'Going cold' },
      { count: 0, name: 'Waiting on others' },
    ]);
  });
});

describe('Parts', () => {
  it('lists a project’s initiatives in tree order, the finished ones apart, each with done over total', () => {
    expect(partsOf(TREE, 'MMR')).toStrictEqual({
      finished: [{ done: 0, id: 'MMR-10', status: 'abandoned', title: 'Old arc', total: 0 }],
      noun: 'initiatives',
      open: [
        { done: 2, id: 'MMR-1', status: 'in_progress', title: 'Console work', total: 3 },
        { done: 0, id: 'MMR-13', status: 'ready', title: 'Next arc', total: 1 },
      ],
    });
  });

  it('lists an initiative’s phases, never its direct tasks', () => {
    expect(partsOf(TREE, 'MMR-1')).toStrictEqual({
      finished: [{ done: 2, id: 'MMR-2', status: 'done', title: 'Phase 1', total: 2 }],
      noun: 'phases',
      // The abandoned task is out of the total.
      open: [{ done: 1, id: 'MMR-5', status: 'in_progress', title: 'Phase 2', total: 2 }],
    });
  });

  it('gives a phase, and an initiative with no phases, no parts', () => {
    expect(partsOf(TREE, 'MMR-5')).toBeUndefined();
    const direct = projectWith([initiative('MMR-50', 'ready', [task('MMR-51', 'ready')])]);
    expect(partsOf(direct, 'MMR-50')).toBeUndefined();
  });

  it('has no parts while the tree has not placed the scope', () => {
    expect(partsOf(undefined, 'MMR-1')).toBeUndefined();
    expect(partsOf(TREE, 'MMR-404')).toBeUndefined();
  });
});

describe('the quiet sentence', () => {
  it('names the latest finish of any task in the scope', () => {
    expect(lastFinishedAt(TREE, 'MMR')).toStrictEqual(daysAgo(1));
    expect(lastFinishedAt(TREE, 'MMR-2')).toStrictEqual(daysAgo(9));
    expect(lastFinishedAt(TREE, 'MMR-13')).toBeUndefined();
  });

  it('says how many days ago the last task finished, in the browser’s zone', () => {
    expect(quietSentence({ lastFinished: daysAgo(9), now: NOW, zone: ZONE })).toBe(
      'Nothing is running, ready to start, or waiting on you. The last task finished 9 days ago.',
    );
    expect(quietSentence({ lastFinished: daysAgo(1), now: NOW, zone: ZONE })).toBe(
      'Nothing is running, ready to start, or waiting on you. The last task finished 1 day ago.',
    );
  });

  it('names no finish when every finished task in the scope was abandoned', () => {
    const abandonedOnly = projectWith([
      phase('MMR-2', 'abandoned', [
        task('MMR-3', 'abandoned'),
        task('MMR-4', 'abandoned', { completedAt: daysAgo(3) }),
      ]),
    ]);

    expect(lastFinishedAt(abandonedOnly, 'MMR')).toBeUndefined();
  });

  it('says only what is quiet when no task in the scope was ever done', () => {
    expect(quietSentence({ lastFinished: undefined, now: NOW, zone: ZONE })).toBe(
      'Nothing is running, ready to start, or waiting on you.',
    );
  });
});

describe('an initiative’s or phase’s Work tab', () => {
  it('shows while it holds a task or a part', () => {
    expect(
      containerHasWork(
        engineContainer({
          distribution: { ready: 1 },
          id: 'MMR-5',
          status: 'ready',
          type: 'phase',
        }),
        undefined,
      ),
    ).toBe(true);
    // An idle open-ended phase is out of its initiative's rollup, but is still a part.
    expect(
      containerHasWork(
        engineContainer({ distribution: {}, id: 'MMR-13', status: 'ready', type: 'initiative' }),
        TREE,
      ),
    ).toBe(true);
  });

  it('hides while nothing is under it, or the tree has not shown a part yet', () => {
    expect(
      containerHasWork(
        engineContainer({ distribution: {}, id: 'MMR-14', status: 'ready', type: 'phase' }),
        TREE,
      ),
    ).toBe(false);
    expect(
      containerHasWork(
        engineContainer({ distribution: {}, id: 'MMR-13', status: 'ready', type: 'initiative' }),
        undefined,
      ),
    ).toBe(false);
  });
});
