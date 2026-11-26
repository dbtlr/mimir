import type { EngineTree } from '@mimir/contract';
import { describe, expect, it } from 'vitest';

import { containerListOf } from '../lib/container-list';
import type { ContainerList } from '../lib/container-list';
import { engineTree } from './engine-fixtures';

/*
 * The sidebar's container list (ADR 0013, MMR-730 refinement): at every level,
 * the parent, the current container, and its child containers, with the
 * finished children set apart for one fold.
 */

function tn(
  id: string,
  type: EngineTree['type'],
  status: EngineTree['status'],
  children: EngineTree[] = [],
  extra: Partial<EngineTree> = {},
): EngineTree {
  return engineTree({ id, status, title: `${id} title`, type, ...extra }, children);
}

/**
 * MMR: a live initiative holding a done phase, a live phase with a task, a
 * parked phase, and an empty phase, plus a direct task; a done initiative; an
 * open-ended one; an abandoned one; a parked one; and a task under the project.
 */
const TREE = tn('MMR', 'project', 'in_progress', [
  tn('MMR-1', 'initiative', 'in_progress', [
    tn('MMR-2', 'phase', 'done', [tn('MMR-3', 'task', 'done'), tn('MMR-4', 'task', 'done')]),
    tn('MMR-5', 'phase', 'in_progress', [
      tn('MMR-6', 'task', 'done'),
      tn('MMR-7', 'task', 'ready'),
      tn('MMR-14', 'task', 'abandoned'),
    ]),
    tn('MMR-15', 'phase', 'parked', [tn('MMR-16', 'task', 'parked')]),
    tn('MMR-17', 'phase', 'ready', [tn('MMR-18', 'task', 'abandoned')]),
    tn('MMR-19', 'task', 'blocked'),
  ]),
  tn('MMR-8', 'initiative', 'done', [tn('MMR-9', 'phase', 'done', [tn('MMR-10', 'task', 'done')])]),
  tn('MMR-11', 'initiative', 'ready', [], { open_ended: true }),
  tn('MMR-12', 'initiative', 'abandoned'),
  tn('MMR-13', 'initiative', 'parked', [tn('MMR-20', 'task', 'parked')]),
  tn('MMR-21', 'task', 'ready'),
]);

const ids = (rows: ContainerList['children']) => rows.map((row) => row.id);

describe('containerListOf: a project', () => {
  const list = containerListOf(TREE, { kind: 'project' });

  it('leads back to Home, with the project as the current row on its own page', () => {
    expect(list.parent).toStrictEqual({ kind: 'home' });
    expect(list.current).toMatchObject({ id: 'MMR', title: 'MMR title', type: 'project' });
    expect(list.mark).toBe('page');
  });

  it('lists the live initiatives in tree order, never a task', () => {
    expect(ids(list.children)).toStrictEqual(['MMR-1', 'MMR-11', 'MMR-13']);
  });

  it('sets the done and abandoned initiatives apart for the fold, in tree order', () => {
    expect(ids(list.finished)).toStrictEqual(['MMR-8', 'MMR-12']);
  });

  it('tallies the project as done over its direct children', () => {
    // MMR-8 and MMR-12's abandonment: 1 done of 5 counted (MMR-12 is left out).
    expect(list.current.tally).toStrictEqual({ done: 1, kind: 'counts', total: 5 });
  });

  it('reads ∞ for an open-ended child, parked for a parked one', () => {
    const tallies = Object.fromEntries(list.children.map((row) => [row.id, row.tally]));
    expect(tallies['MMR-11']).toStrictEqual({ kind: 'open_ended' });
    expect(tallies['MMR-13']).toStrictEqual({ kind: 'parked' });
  });
});

describe('containerListOf: an initiative', () => {
  const list = containerListOf(TREE, { id: 'MMR-1', kind: 'node' });

  it('leads back to the project, with the initiative as the page', () => {
    expect(list.parent).toStrictEqual({
      id: 'MMR',
      kind: 'container',
      title: 'MMR title',
      type: 'project',
    });
    expect(list.current).toMatchObject({ id: 'MMR-1', type: 'initiative' });
    expect(list.mark).toBe('page');
  });

  it('lists its live phases, not its direct task, and folds the finished ones', () => {
    expect(ids(list.children)).toStrictEqual(['MMR-5', 'MMR-15', 'MMR-17']);
    expect(ids(list.finished)).toStrictEqual(['MMR-2']);
  });

  it('tallies each phase in order: parked, then Empty, then done over the rest', () => {
    const tallies = Object.fromEntries(list.children.map((row) => [row.id, row.tally]));
    // The abandoned task is out of the count.
    expect(tallies['MMR-5']).toStrictEqual({ done: 1, kind: 'counts', total: 2 });
    expect(tallies['MMR-15']).toStrictEqual({ kind: 'parked' });
    // Its one child is abandoned, so nothing is under it.
    expect(tallies['MMR-17']).toStrictEqual({ kind: 'empty' });
  });

  it('reads ∞ before Empty for an open-ended container with nothing under it', () => {
    const open = containerListOf(TREE, { id: 'MMR-11', kind: 'node' });
    expect(open.current.tally).toStrictEqual({ kind: 'open_ended' });
  });

  it('reads Empty for a container with no children at all', () => {
    const gone = containerListOf(TREE, { id: 'MMR-12', kind: 'node' });
    expect(gone.current.tally).toStrictEqual({ kind: 'empty' });
  });
});

describe('containerListOf: a phase', () => {
  it('leads back to its initiative and ends at the phase', () => {
    const list = containerListOf(TREE, { id: 'MMR-5', kind: 'node' });
    expect(list.parent).toStrictEqual({
      id: 'MMR-1',
      kind: 'container',
      title: 'MMR-1 title',
      type: 'initiative',
    });
    expect(list.current).toMatchObject({ id: 'MMR-5', type: 'phase' });
    expect(list.mark).toBe('page');
    expect(list.children).toStrictEqual([]);
    expect(list.finished).toStrictEqual([]);
  });
});

describe('containerListOf: a task', () => {
  it('under a phase rings the phase, led back to its initiative', () => {
    const list = containerListOf(TREE, { id: 'MMR-7', kind: 'node' });
    expect(list.parent).toMatchObject({ id: 'MMR-1', kind: 'container' });
    expect(list.current).toMatchObject({ id: 'MMR-5' });
    expect(list.mark).toBe('holds');
    expect(list.children).toStrictEqual([]);
  });

  it('directly under an initiative rings the initiative, with its phases', () => {
    const list = containerListOf(TREE, { id: 'MMR-19', kind: 'node' });
    expect(list.parent).toMatchObject({ id: 'MMR', kind: 'container' });
    expect(list.current).toMatchObject({ id: 'MMR-1' });
    expect(list.mark).toBe('holds');
    expect(ids(list.children)).toStrictEqual(['MMR-5', 'MMR-15', 'MMR-17']);
    expect(ids(list.finished)).toStrictEqual(['MMR-2']);
  });

  it('directly under the project rings the project, led back to Home', () => {
    const list = containerListOf(TREE, { id: 'MMR-21', kind: 'node' });
    expect(list.parent).toStrictEqual({ kind: 'home' });
    expect(list.current).toMatchObject({ id: 'MMR' });
    expect(list.mark).toBe('holds');
  });

  it('inside a finished initiative rings its phase like any other', () => {
    const list = containerListOf(TREE, { id: 'MMR-10', kind: 'node' });
    expect(list.parent).toMatchObject({ id: 'MMR-8' });
    expect(list.current).toMatchObject({ id: 'MMR-9' });
    expect(list.mark).toBe('holds');
  });
});

describe('containerListOf: a page the project holds', () => {
  it('rings the project on Tasks, a seed, an artifact, or a delivery page', () => {
    const list = containerListOf(TREE, { kind: 'held' });
    expect(list.parent).toStrictEqual({ kind: 'home' });
    expect(list.current).toMatchObject({ id: 'MMR' });
    expect(list.mark).toBe('holds');
    expect(ids(list.children)).toStrictEqual(['MMR-1', 'MMR-11', 'MMR-13']);
  });

  it('rings the project on a path that names no record in its tree', () => {
    const list = containerListOf(TREE, { id: 'MMR-99', kind: 'node' });
    expect(list.current).toMatchObject({ id: 'MMR' });
    expect(list.mark).toBe('holds');
  });
});
