// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { EngineNode } from '@mimir/contract';

import type {
  FrontierTask,
  NeedsYouTask,
  NowTask,
  ReviewReport,
  ShippedTask,
  TriageSeed,
  WorkReport,
} from '../api/view-queries';
import { FIXTURE_AT, engineNode } from './engine-fixtures';

/*
 * Engine-shaped composite pages: the review report and the work report as the
 * console's Engine methods return them, with `Date` instants. The row builders
 * wrap a task the way the Engine's rows do (`{ task, ...row fields }`).
 */

/** A work page with every section empty; override the ones a case fills. */
export function engineWork(overrides: Partial<WorkReport> = {}): WorkReport {
  return {
    frontier: { nextToUnlock: [], runnable: [], toGroom: [], waitingOnOthers: [] },
    goingCold: [],
    needsYou: [],
    now: [],
    scope: { id: 'MMR', kind: 'project', title: 'Mimir' },
    shipped: [],
    ...overrides,
  };
}

/** The review page with nothing in it; override the parts a case fills. */
export function engineReview(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    decisions: [],
    goingCold: [],
    lastFinished: null,
    now: [],
    projects: [],
    queue: [],
    runnable: [],
    shipped: [],
    triage: [],
    ...overrides,
  };
}

type TaskFields = Partial<EngineNode> & Pick<EngineNode, 'status'>;

/** A task record as a work row carries it. */
export function workTask(overrides: TaskFields): EngineNode {
  return engineNode({
    deps: { awaitingOn: [], blocking: [], dependsOn: [] },
    hold: 'none',
    lifecycle: 'todo',
    parent: 'MMR-1',
    type: 'task',
    ...overrides,
  });
}

/** A task that needs the operator. */
export function needsYouRow(
  overrides: TaskFields,
  reason: NeedsYouTask['reason'],
  row: Partial<Omit<NeedsYouTask, 'task' | 'reason'>> = {},
): NeedsYouTask {
  return { question: null, reason, stale: false, task: workTask(overrides), ...row };
}

/** A task in progress. */
export function nowRow(
  overrides: Partial<EngineNode> = {},
  row: Partial<Omit<NowTask, 'task'>> = {},
): NowTask {
  return {
    latestNote: null,
    scratchpads: [],
    stale: false,
    startedAt: FIXTURE_AT,
    task: workTask({ status: 'in_progress', ...overrides }),
    ...row,
  };
}

/** A task on the frontier. */
export function frontierRow(
  overrides: TaskFields,
  row: Partial<Omit<FrontierTask, 'task'>> = {},
): FrontierTask {
  return { awaitingOn: [], breakDown: false, stale: false, task: workTask(overrides), ...row };
}

/** A task that finished inside the shipped window. */
export function shippedRow(
  overrides: Partial<EngineNode> & { id?: string },
  finishedAt: Date,
  row: Partial<Omit<ShippedTask, 'task' | 'finishedAt'>> = {},
): ShippedTask {
  return {
    abandonReason: null,
    finishedAt,
    stale: false,
    task: workTask({ status: 'done', ...overrides }),
    ...row,
  };
}

/** A work-page row tagged with its project, as the review page lists it. */
export function tagged<R extends { task: EngineNode }>(row: R): R & { project: string } {
  return { ...row, project: row.task.id.split('-')[0] ?? 'MMR' };
}

/** A project's strip row on the review page. */
export function stripRow(
  ref: { key: string; name: string },
  counts: Partial<ReviewReport['projects'][number]> = {},
): ReviewReport['projects'][number] {
  return { ...ref, decisions: 0, goingCold: 0, inFlight: 0, live: 0, triage: 0, ...counts };
}

/** An untriaged seed as the review page lists it. */
export function triageSeed(overrides: Partial<TriageSeed> & Pick<TriageSeed, 'id'>): TriageSeed {
  return {
    createdAt: FIXTURE_AT,
    kind: 'idea',
    lifecycle: 'new',
    project: overrides.id.split('-')[0] ?? 'MMR',
    readyToResolve: false,
    requester: null,
    spawned: [],
    title: `seed ${overrides.id}`,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}
