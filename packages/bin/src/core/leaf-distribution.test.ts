import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Hold, Lifecycle } from '@mimir/contract';

import { nodeIdOf, projectIdOf, createTestStore } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet, leafDistribution } from './derive';
import type { Store } from './store';

/**
 * MMR-105 — the per-project leaf-status tally. The leaf-level sibling of
 * `childDistribution` (direct children) / `rootDistribution` (project roots):
 * every leaf task in the project, its derived status word tallied. Backs the
 * project card's vitals panel (MMR-106).
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
});
afterEach(async () => {
  await closeStore();
});

const setOf = async () => deriveSet(await store.loadWorkingSet());

async function patch(id: number, fields: { lifecycle?: Lifecycle; hold?: Hold }): Promise<void> {
  await store.transact((w) => w.updateNode(id, fields));
}
async function dep(nodeId: number, dependsOn: number): Promise<void> {
  await store.transact((w) =>
    w.insertDependency({ depends_on_node_id: dependsOn, node_id: nodeId }),
  );
}

async function fixture(key = 'MMR') {
  const p = await createProject(store, { key, name: 'm' });
  const projectId = await projectIdOf(store, key);
  const init = await createInitiative(store, { projectId, title: 'i' });
  const initId = await nodeIdOf(store, `${key}-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  return { init, key, p, phase, projectId };
}

test.skipIf(!NORN)('an empty project tallies to {}', async () => {
  const { projectId } = await fixture();
  expect(leafDistribution(await setOf(), projectId)).toEqual({});
});

test.skipIf(!NORN)(
  "tallies every leaf task's derived status word across the whole project",
  async () => {
    const { key, projectId, phase } = await fixture();
    const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
    // ready (fresh), in_progress, under_review, blocked
    await createTask(store, { parentId: phaseId, title: 'ready' });
    const prog = await createTask(store, { parentId: phaseId, title: 'prog' });
    await patch(await nodeIdOf(store, `${key}-${String(prog.seq)}`), { lifecycle: 'in_progress' });
    const review = await createTask(store, { parentId: phaseId, title: 'review' });
    await patch(await nodeIdOf(store, `${key}-${String(review.seq)}`), {
      lifecycle: 'under_review',
    });
    const blocked = await createTask(store, { parentId: phaseId, title: 'blocked' });
    await patch(await nodeIdOf(store, `${key}-${String(blocked.seq)}`), { hold: 'blocked' });

    expect(leafDistribution(await setOf(), projectId)).toEqual({
      blocked: 1,
      in_progress: 1,
      ready: 1,
      under_review: 1,
    });
  },
);

test.skipIf(!NORN)(
  'tallies the held and terminal buckets too (parked / done / abandoned)',
  async () => {
    const { key, projectId, phase } = await fixture();
    const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
    const parked = await createTask(store, { parentId: phaseId, title: 'parked' });
    await patch(await nodeIdOf(store, `${key}-${String(parked.seq)}`), { hold: 'parked' });
    const done = await createTask(store, { parentId: phaseId, title: 'done' });
    await patch(await nodeIdOf(store, `${key}-${String(done.seq)}`), { lifecycle: 'done' });
    const gone = await createTask(store, { parentId: phaseId, title: 'gone' });
    await patch(await nodeIdOf(store, `${key}-${String(gone.seq)}`), { lifecycle: 'abandoned' });
    expect(leafDistribution(await setOf(), projectId)).toEqual({
      abandoned: 1,
      done: 1,
      parked: 1,
    });
  },
);

test.skipIf(!NORN)(
  'counts the derived awaiting word (todo with an unsettled prerequisite)',
  async () => {
    const { key, projectId, phase } = await fixture();
    const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
    const a = await createTask(store, { parentId: phaseId, title: 'a' });
    const b = await createTask(store, { parentId: phaseId, title: 'b' });
    const aId = await nodeIdOf(store, `${key}-${String(a.seq)}`);
    const bId = await nodeIdOf(store, `${key}-${String(b.seq)}`);
    await dep(bId, aId); // b awaits a; a is ready
    expect(leafDistribution(await setOf(), projectId)).toEqual({ awaiting: 1, ready: 1 });
  },
);

test.skipIf(!NORN)(
  'tallies leaves across multiple phases, excluding the containers themselves',
  async () => {
    const { key, projectId, init } = await fixture();
    const initId = await nodeIdOf(store, `${key}-${String(init.seq)}`);
    const ph2 = await createPhase(store, { parentId: initId, title: 'ph2' });
    const ph2Id = await nodeIdOf(store, `${key}-${String(ph2.seq)}`);
    await createTask(store, { parentId: ph2Id, title: 'x' });
    // first phase has no tasks; second has one ready leaf
    const dist = leafDistribution(await setOf(), projectId);
    // only the single leaf task is counted — initiatives/phases never appear
    expect(dist).toEqual({ ready: 1 });
  },
);

test.skipIf(!NORN)('scopes to the project — no cross-project leak', async () => {
  const mine = await fixture('AAA');
  const minePhaseId = await nodeIdOf(store, `AAA-${String(mine.phase.seq)}`);
  await createTask(store, { parentId: minePhaseId, title: 'mine' });

  const other = await fixture('BBB');
  const otherPhaseId = await nodeIdOf(store, `BBB-${String(other.phase.seq)}`);
  await createTask(store, { parentId: otherPhaseId, title: 'theirs' });
  const stuck = await createTask(store, { parentId: otherPhaseId, title: 'stuck' });
  await patch(await nodeIdOf(store, `BBB-${String(stuck.seq)}`), { hold: 'blocked' });

  const mineProjectId = await projectIdOf(store, 'AAA');
  const otherProjectId = await projectIdOf(store, 'BBB');
  expect(leafDistribution(await setOf(), mineProjectId)).toEqual({ ready: 1 });
  expect(leafDistribution(await setOf(), otherProjectId)).toEqual({ blocked: 1, ready: 1 });
});
