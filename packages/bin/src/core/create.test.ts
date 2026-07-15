import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { RANK_STEP } from './rank';
import type { Store } from './store';
import { expectMimirError } from './testing';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
});
afterEach(async () => {
  await closeStore();
});

test.skipIf(!NORN)('createProject stores optional description (MMR-88)', async () => {
  const withDesc = await createProject(store, {
    description: 'tracks work',
    key: 'MMR',
    name: 'Mimir',
  });
  expect(withDesc.description).toBe('tracks work');

  const withoutDesc = await createProject(store, { key: 'NRN', name: 'Norn' });
  expect(withoutDesc.description).toBeNull();
});

test.skipIf(!NORN)('createProject rejects a bad key and a duplicate key', async () => {
  await expectMimirError('validation', () => createProject(store, { key: 'm1', name: 'bad' }));
  await expectMimirError('validation', () => createProject(store, { key: 'TOOLONG', name: 'bad' }));
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  await expectMimirError('conflict', () => createProject(store, { key: 'MMR', name: 'again' }));
});

test.skipIf(!NORN)('seq is per-project, monotonic, and shared across node types', async () => {
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  const task = await createTask(store, {
    parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
    title: 't',
  });
  expect([init.seq, phase.seq, task.seq]).toEqual([1, 2, 3]);

  // a second project allocates independently
  await createProject(store, { key: 'NRN', name: 'Norn' });
  const init2 = await createInitiative(store, {
    projectId: await projectIdOf(store, 'NRN'),
    title: 'i2',
  });
  expect(init2.seq).toBe(1);
});

test.skipIf(!NORN)(
  'createInitiative is top-level (null parent) and requires a real project',
  async () => {
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const init = await createInitiative(store, {
      projectId: await projectIdOf(store, 'MMR'),
      title: 'i',
    });
    expect(init.type).toBe('initiative');
    expect(init.parent_id).toBeNull();
    expect(init.lifecycle).toBeNull(); // non-tasks store no status
    await expectMimirError('not_found', () =>
      createInitiative(store, { projectId: 'ZZZ', title: 'x' }),
    );
  },
);

test.skipIf(!NORN)(
  'createPhase requires an initiative parent and inherits project_id',
  async () => {
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
    const phase = await createPhase(store, { parentId: initId, target: 'ship it', title: 'ph' });
    expect(phase.type).toBe('phase');
    expect(phase.project_id).toBe(projectId);
    expect(phase.parent_id).toBe(initId);
    expect(phase.target).toBe('ship it');

    // a phase under a phase is rejected
    const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
    await expectMimirError('validation', () =>
      createPhase(store, { parentId: phaseId, title: 'no' }),
    );
    await expectMimirError('not_found', () =>
      createPhase(store, { parentId: 'MMR-999', title: 'no' }),
    );
  },
);

test.skipIf(!NORN)(
  'createTask stores optional summary, reloads from the vault, and strips newlines (MMR-162)',
  async () => {
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const init = await createInitiative(store, {
      projectId: await projectIdOf(store, 'MMR'),
      title: 'i',
    });
    const phase = await createPhase(store, {
      parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
      title: 'ph',
    });
    const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);

    const t = await createTask(store, {
      parentId: phaseId,
      summary: 'line one\r\nline two',
      title: 't',
    });
    expect(t.summary).toBe('line one line two');
    const reloaded = (await store.loadWorkingSet()).nodes.find(
      (n) => n.seq === t.seq && n.type === 'task',
    );
    expect(reloaded?.summary).toBe('line one line two');

    const noSummary = await createTask(store, { parentId: phaseId, title: 't2' });
    expect(noSummary.summary).toBeNull();

    await expectMimirError('validation', () =>
      createTask(store, { parentId: phaseId, summary: 'x'.repeat(257), title: 't3' }),
    );
  },
);

test.skipIf(!NORN)(
  'createTask sets both axes, ranks at append step, and accepts phase or initiative parents',
  async () => {
    await createProject(store, { key: 'MMR', name: 'Mimir' });
    const init = await createInitiative(store, {
      projectId: await projectIdOf(store, 'MMR'),
      title: 'i',
    });
    const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
    const phase = await createPhase(store, { parentId: initId, title: 'ph' });
    const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);

    const t1 = await createTask(store, {
      parentId: phaseId,
      priority: 'p1',
      size: 'small',
      title: 't1',
    });
    expect(t1.type).toBe('task');
    expect(t1.lifecycle).toBe('todo');
    expect(t1.hold).toBe('none');
    expect(t1.priority).toBe('p1');
    expect(t1.rank).toBe(RANK_STEP);

    const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
    expect(t2.rank).toBe(RANK_STEP * 2); // appends below t1

    // a task directly under an initiative is allowed (phaseless initiative)
    const t3 = await createTask(store, { parentId: initId, title: 't3' });
    expect(t3.parent_id).toBe(initId);

    // a task under a task is rejected
    const t1Id = await nodeIdOf(store, `MMR-${String(t1.seq)}`);
    await expectMimirError('validation', () => createTask(store, { parentId: t1Id, title: 'no' }));
  },
);
