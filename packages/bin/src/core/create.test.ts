import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createInitiative, createNode, createPhase, createProject, createTask } from './create';
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

// ─── createNode dispatch + validation (MMR-304) ──────────────────────────────

/** Build a project + initiative + phase via createNode; return their refs. */
async function scaffold(s: Store): Promise<{ initRef: string; phaseRef: string; taskRef: string }> {
  await createNode(s, { key: 'MMR', name: 'Mimir', type: 'project' });
  const init = await createNode(s, { parent: 'MMR', title: 'i', type: 'initiative' });
  const initRef = `MMR-${String(init.seq)}`;
  const phase = await createNode(s, { parent: initRef, title: 'ph', type: 'phase' });
  const phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createNode(s, { parent: phaseRef, title: 't', type: 'task' });
  const taskRef = `MMR-${String(task.seq)}`;
  return { initRef, phaseRef, taskRef };
}

test.skipIf(!NORN)('createNode dispatches each type to its verb', async () => {
  const project = await createNode(store, { key: 'MMR', name: 'Mimir', type: 'project' });
  expect(project.key).toBe('MMR');
  const init = await createNode(store, { parent: 'MMR', title: 'i', type: 'initiative' });
  expect(init.type).toBe('initiative');
  const phase = await createNode(store, {
    parent: `MMR-${String(init.seq)}`,
    title: 'ph',
    type: 'phase',
  });
  expect(phase.type).toBe('phase');
  const task = await createNode(store, {
    parent: `MMR-${String(phase.seq)}`,
    title: 't',
    type: 'task',
  });
  expect(task.type).toBe('task');
  // a task directly under an initiative is allowed (phaseless initiative)
  const task2 = await createNode(store, {
    parent: `MMR-${String(init.seq)}`,
    title: 't2',
    type: 'task',
  });
  expect(task2.parent_id).toBe(init.id);
});

test.skipIf(!NORN)('createNode rejects a non-project token as an initiative parent', async () => {
  const { taskRef } = await scaffold(store);
  // wrong shape (a node ref) short-circuits before any store read
  await expectMimirError('validation', () =>
    createNode(store, { parent: taskRef, title: 'x', type: 'initiative' }),
  );
});

test.skipIf(!NORN)('createNode rejects a non-node token as a phase/task parent', async () => {
  await scaffold(store);
  await expectMimirError('validation', () =>
    createNode(store, { parent: 'MMR', title: 'x', type: 'phase' }),
  );
  await expectMimirError('validation', () =>
    createNode(store, { parent: 'MMR', title: 'x', type: 'task' }),
  );
});

test.skipIf(!NORN)(
  'createNode names a wrong-kind parent and carries transport hints (MMR-304)',
  async () => {
    await scaffold(store);
    // A recognizable-but-wrong kind gets the resolver's kind-aware wording,
    // with the envelope's hint carried through the parentHints seam.
    let wrongKind: unknown;
    try {
      await createNode(store, {
        parent: 'MMR-a1',
        parentHints: { artifact: 'artifacts live at /api/artifacts' },
        title: 'x',
        type: 'task',
      });
    } catch (error) {
      wrongKind = error;
    }
    expect(wrongKind).toMatchObject({
      code: 'validation',
      hint: 'artifacts live at /api/artifacts',
      message: 'MMR-a1 is an artifact, not a phase or initiative',
    });
    // A well-formed ref that resolves to nothing carries the notFound hint.
    let missing: unknown;
    try {
      await createNode(store, {
        parent: 'MMR-999',
        parentHints: { notFound: 'see what exists: mimir list -f ids' },
        title: 'x',
        type: 'phase',
      });
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({
      code: 'not_found',
      hint: 'see what exists: mimir list -f ids',
      message: "MMR-999 doesn't exist",
    });
  },
);

test.skipIf(!NORN)('createNode surfaces the in-transact parent-type recheck', async () => {
  const { taskRef, phaseRef } = await scaffold(store);
  // a phase under a task (right shape, wrong type) — createPhase rechecks
  await expectMimirError('validation', () =>
    createNode(store, { parent: taskRef, title: 'x', type: 'phase' }),
  );
  // a task under a phase is fine, but under another task is rejected
  await expectMimirError('validation', () =>
    createNode(store, { parent: taskRef, title: 'x', type: 'task' }),
  );
  expect((await createNode(store, { parent: phaseRef, title: 'ok', type: 'task' })).type).toBe(
    'task',
  );
});

test.skipIf(!NORN)('createNode validates priority and size enums from raw strings', async () => {
  const { phaseRef } = await scaffold(store);
  await expectMimirError('validation', () =>
    createNode(store, { parent: phaseRef, priority: 'p9', title: 'x', type: 'task' }),
  );
  await expectMimirError('validation', () =>
    createNode(store, { parent: phaseRef, size: 'huge', title: 'x', type: 'task' }),
  );
  // a valid enum passes through
  const task = await createNode(store, {
    parent: phaseRef,
    priority: 'p1',
    size: 'small',
    title: 'x',
    type: 'task',
  });
  expect(task.priority).toBe('p1');
  expect(task.size).toBe('small');
});

test.skipIf(!NORN)('createNode rejects a malformed upstream token', async () => {
  const { phaseRef } = await scaffold(store);
  await expectMimirError('validation', () =>
    createNode(store, { parent: phaseRef, title: 'x', type: 'task', upstream: 'not-a-seed' }),
  );
});

test.skipIf(!NORN)('createNode enforces the open_ended container-only rule (MMR-204)', async () => {
  const { initRef, phaseRef } = await scaffold(store);
  await expectMimirError('validation', () =>
    createNode(store, { key: 'OPN', name: 'x', openEnded: true, type: 'project' }),
  );
  await expectMimirError('validation', () =>
    createNode(store, { openEnded: true, parent: phaseRef, title: 'x', type: 'task' }),
  );
  // initiative and phase accept it
  const init = await createNode(store, {
    openEnded: true,
    parent: 'MMR',
    title: 'oe',
    type: 'initiative',
  });
  expect(init.open_ended).toBe(true);
  const phase = await createNode(store, {
    openEnded: true,
    parent: initRef,
    title: 'oe',
    type: 'phase',
  });
  expect(phase.open_ended).toBe(true);
});
