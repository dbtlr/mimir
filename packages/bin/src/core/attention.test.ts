import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Hold, Lifecycle } from '@mimir/contract';

import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { attentionOf } from './attention';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { deriveSet } from './derive';
import type { Store } from './store';

/**
 * MMR-101 — the derived project attention-state. Lanes resolve highest-wins over
 * a project's leaf tasks; `stale` is a modifier; `lastActivity` is the recency
 * floor the consumer (MMR-102) sorts within a lane.
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

async function patch(
  key: string,
  seq: number,
  fields: { lifecycle?: Lifecycle; hold?: Hold },
): Promise<void> {
  const id = await nodeIdOf(store, `${key}-${String(seq)}`);
  await store.transact((w) => w.updateNode(id, fields));
}
async function touch(key: string, seq: number, at: string): Promise<void> {
  const id = await nodeIdOf(store, `${key}-${String(seq)}`);
  await store.transact((w) => w.updateNode(id, { updated_at: at }));
}
async function dep(key: string, nodeSeq: number, dependsOnSeq: number): Promise<void> {
  const nodeId = await nodeIdOf(store, `${key}-${String(nodeSeq)}`);
  const dependsOnId = await nodeIdOf(store, `${key}-${String(dependsOnSeq)}`);
  await store.transact((w) =>
    w.insertDependency({ depends_on_node_id: dependsOnId, node_id: nodeId }),
  );
}

/** A project with one empty phase ready to hang tasks under. */
async function fixture(key = 'MMR') {
  const p = await createProject(store, { key, name: 'm' });
  const projectId = await projectIdOf(store, key);
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `${key}-${String(init.seq)}`),
    title: 'ph',
  });
  return { key, p, phase };
}

/** Reload a project by key from a fresh working set (attentionOf reads a Project). */
async function reloadProject(key: string) {
  const projects = (await store.loadWorkingSet()).projects;
  const project = projects.find((pr) => pr.key === key);
  if (project === undefined) {
    throw new Error(`no project ${key}`);
  }
  return project;
}

test.skipIf(!NORN)(
  'an empty project (no leaf tasks) is at_rest, recency falling back to the project itself',
  async () => {
    const { key } = await fixture();
    const p = await reloadProject(key);
    const a = attentionOf(await setOf(), p);
    expect(a.lane).toBe('at_rest');
    expect(a.stale).toBe(false);
    expect(a.lastActivity).toBe(p.updated_at);
  },
);

test.skipIf(!NORN)(
  'a project whose only live signal is under_review lands in awaiting_you',
  async () => {
    const { key, phase } = await fixture();
    const t = await createTask(store, {
      parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
      title: 't',
    });
    await patch(key, t.seq, { lifecycle: 'under_review' });
    const p = await reloadProject(key);
    expect(attentionOf(await setOf(), p).lane).toBe('awaiting_you');
  },
);

test.skipIf(!NORN)('in_progress and ready leaves both read as live', async () => {
  const { key, phase } = await fixture();
  const running = await createTask(store, {
    parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
    title: 'running',
  });
  await patch(key, running.seq, { lifecycle: 'in_progress' });
  const p = await reloadProject(key);
  expect(attentionOf(await setOf(), p).lane).toBe('live');

  const { key: key2, phase: ph2 } = await fixture('RDY');
  await createTask(store, {
    parentId: await nodeIdOf(store, `${key2}-${String(ph2.seq)}`),
    title: 'fresh',
  }); // todo + none, no deps → ready
  const p2 = await reloadProject(key2);
  expect(attentionOf(await setOf(), p2).lane).toBe('live');
});

test.skipIf(!NORN)('blocked and awaiting leaves both read as needs_unsticking', async () => {
  const { key, phase } = await fixture();
  const stuck = await createTask(store, {
    parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
    title: 'stuck',
  });
  await patch(key, stuck.seq, { hold: 'blocked' });
  const p = await reloadProject(key);
  expect(attentionOf(await setOf(), p).lane).toBe('needs_unsticking');

  const { key: key2, phase: ph2 } = await fixture('AWT');
  const ph2Id = await nodeIdOf(store, `${key2}-${String(ph2.seq)}`);
  const prereq = await createTask(store, { parentId: ph2Id, title: 'prereq' });
  const dependent = await createTask(store, { parentId: ph2Id, title: 'dependent' });
  await dep(key2, dependent.seq, prereq.seq); // prereq unsettled → dependent awaits
  await patch(key2, prereq.seq, { hold: 'parked' }); // park the prereq so the project's top lane is the awaiting leaf
  const p2 = await reloadProject(key2);
  expect(attentionOf(await setOf(), p2).lane).toBe('needs_unsticking');
});

test.skipIf(!NORN)('a project of only parked/terminal leaves is at_rest', async () => {
  const { key, phase } = await fixture();
  const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  const parked = await createTask(store, { parentId: phaseId, title: 'parked' });
  await patch(key, parked.seq, { hold: 'parked' });
  const done = await createTask(store, { parentId: phaseId, title: 'done' });
  await patch(key, done.seq, { lifecycle: 'done' });
  const gone = await createTask(store, { parentId: phaseId, title: 'gone' });
  await patch(key, gone.seq, { lifecycle: 'abandoned' });
  const p = await reloadProject(key);
  const a = attentionOf(await setOf(), p);
  expect(a.lane).toBe('at_rest');
  expect(a.stale).toBe(false);
});

test.skipIf(!NORN)('the highest lane wins when leaves span several lanes', async () => {
  const { key, phase } = await fixture();
  const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  const review = await createTask(store, { parentId: phaseId, title: 'review' });
  await patch(key, review.seq, { lifecycle: 'under_review' });
  await createTask(store, { parentId: phaseId, title: 'ready' }); // live
  const blocked = await createTask(store, { parentId: phaseId, title: 'blocked' });
  await patch(key, blocked.seq, { hold: 'blocked' }); // needs_unsticking

  // awaiting_you (under_review) outranks live and needs_unsticking
  const p = await reloadProject(key);
  expect(attentionOf(await setOf(), p).lane).toBe('awaiting_you');

  // drop the review to done → highest remaining is live (the ready leaf)
  await patch(key, review.seq, { lifecycle: 'done' });
  expect(attentionOf(await setOf(), p).lane).toBe('live');
});

test.skipIf(!NORN)(
  'highest-wins is independent of scan order — the winning leaf created last still wins',
  async () => {
    const { key, phase } = await fixture();
    const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
    // lower lanes first, the awaiting_you leaf created last (so it scans last)
    const blocked = await createTask(store, { parentId: phaseId, title: 'blocked' });
    await patch(key, blocked.seq, { hold: 'blocked' }); // needs_unsticking
    await createTask(store, { parentId: phaseId, title: 'ready' }); // live
    const review = await createTask(store, { parentId: phaseId, title: 'review' });
    await patch(key, review.seq, { lifecycle: 'under_review' }); // awaiting_you, created last
    const p = await reloadProject(key);
    expect(attentionOf(await setOf(), p).lane).toBe('awaiting_you');
  },
);

test.skipIf(!NORN)(
  'stale is a modifier that decorates the live lane, not a lane of its own',
  async () => {
    const { key, phase } = await fixture();
    const t = await createTask(store, {
      parentId: await nodeIdOf(store, `${key}-${String(phase.seq)}`),
      title: 't',
    });
    await patch(key, t.seq, { lifecycle: 'in_progress' });
    await touch(key, t.seq, '2000-01-01T00:00:00.000Z'); // ancient
    const asOf = '2026-06-05T00:00:00.000Z';

    const p = await reloadProject(key);
    const a = attentionOf(await setOf(), p, { asOf });
    expect(a.lane).toBe('live'); // still its real lane
    expect(a.stale).toBe(true); // going cold rides on top

    // a fresh in_progress leaf is not stale
    await touch(key, t.seq, asOf);
    expect(attentionOf(await setOf(), p, { asOf }).stale).toBe(false);
  },
);

test.skipIf(!NORN)(
  "lastActivity is the max updated_at across the project's leaf tasks",
  async () => {
    const { key, phase } = await fixture();
    const phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
    const older = await createTask(store, { parentId: phaseId, title: 'older' });
    const newer = await createTask(store, { parentId: phaseId, title: 'newer' });
    await touch(key, older.seq, '2026-01-01T00:00:00.000Z');
    await touch(key, newer.seq, '2026-06-20T12:00:00.000Z');
    const p = await reloadProject(key);
    expect(attentionOf(await setOf(), p).lastActivity).toBe('2026-06-20T12:00:00.000Z');
  },
);
