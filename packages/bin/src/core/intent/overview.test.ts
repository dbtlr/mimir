import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { blockTask, depend, startTask, submitTask } from '../mutations';
import { fileSeed } from '../seeds';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { overviewOf } from './index';

/**
 * `overviewOf` (MMR-278) — the composite orientation query. One working-set load
 * derives every section; counts-before-contents holds under the next/awaiting cap.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
});
afterEach(async () => {
  await closeStore();
});

const idOf = (n: { seq: number }): string => `MMR-${String(n.seq)}`;

test.skipIf(!NORN)('overviewOf composes the five sections with true counts', async () => {
  // 6 plain ready tasks + a ready prereq = 7 ready; a dependent awaits the prereq.
  for (let i = 0; i < 6; i += 1) {
    await createTask(store, { parentId: phaseId, title: `ready-${String(i)}` });
  }
  const prereq = await createTask(store, { parentId: phaseId, title: 'prereq' });
  const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
  await depend(store, idOf(dependent), [idOf(prereq)]);

  // in flight: one in_progress, one under_review.
  const started = await createTask(store, { parentId: phaseId, title: 'started' });
  await startTask(store, idOf(started));
  const reviewed = await createTask(store, { parentId: phaseId, title: 'reviewed' });
  await startTask(store, idOf(reviewed));
  await submitTask(store, idOf(reviewed));

  // hygiene: one blocked task, two untriaged seeds.
  const blocked = await createTask(store, { parentId: phaseId, title: 'blocked' });
  await blockTask(store, idOf(blocked), 'external');
  await fileSeed(store, { kind: 'idea', project: 'MMR', title: 'seed one' });
  await fileSeed(store, { kind: 'bug', project: 'MMR', title: 'seed two' });

  const report = await overviewOf(store, 'MMR');

  expect(report.project.id).toBe('MMR');
  // One project root (the initiative) contributes the whole rollup.
  const rootTotal = Object.values(report.project.distribution).reduce((s, c) => s + c, 0);
  expect(rootTotal).toBe(1);

  // in flight — uncapped, both the started and the reviewed task.
  expect(report.inFlight.count).toBe(2);
  expect(report.inFlight.tasks).toHaveLength(2);
  expect(report.inFlight.tasks.map((t) => t.status).toSorted()).toEqual([
    'in_progress',
    'under_review',
  ]);

  // next — true count 7, capped at 5.
  expect(report.next.count).toBe(7);
  expect(report.next.tasks).toHaveLength(5);
  expect(report.next.tasks.every((t) => t.status === 'ready')).toBe(true);

  // awaiting — the dependent, carrying the upstream id it awaits.
  expect(report.awaiting.count).toBe(1);
  expect(report.awaiting.tasks).toHaveLength(1);
  expect(report.awaiting.tasks[0]?.task.id).toBe(idOf(dependent));
  expect(report.awaiting.tasks[0]?.task.status).toBe('awaiting');
  expect(report.awaiting.tasks[0]?.awaitingOn).toEqual([idOf(prereq)]);

  // hygiene — counts only.
  expect(report.hygiene.untriaged).toBe(2);
  expect(report.hygiene.blocked).toBe(1);
  expect(report.hygiene.stale).toBe(0);
  expect(report.hygiene.dropped).toBe(0);
});

test.skipIf(!NORN)('empty sections carry a zero count', async () => {
  const report = await overviewOf(store, 'MMR');
  expect(report.inFlight).toEqual({ count: 0, tasks: [] });
  expect(report.next).toEqual({ count: 0, tasks: [] });
  expect(report.awaiting).toEqual({ count: 0, tasks: [] });
  expect(report.hygiene).toEqual({ blocked: 0, dropped: 0, stale: 0, untriaged: 0 });
});

test.skipIf(!NORN)('stale hygiene counts tasks quiet past the threshold (asOf)', async () => {
  const started = await createTask(store, { parentId: phaseId, title: 'started' });
  await startTask(store, idOf(started));
  // 100 days after the task's touch — well past the 14-day stale threshold.
  const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
  const report = await overviewOf(store, 'MMR', { asOf: future });
  expect(report.hygiene.stale).toBeGreaterThanOrEqual(1);
});

test.skipIf(!NORN)('an unknown scope key throws not_found', async () => {
  await expectMimirError('not_found', () => overviewOf(store, 'ZZZ'));
});
