import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Lifecycle } from '@mimir/contract';

import { createTestStore, nodeIdOf, projectIdOf, rawDep, rawPatchNode } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { childDistribution, deriveSet, nodeStatusWord, statusOf } from './derive';
import type { Store } from './store';

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

async function setLifecycle(key: string, seq: number, lifecycle: Lifecycle): Promise<void> {
  await rawPatchNode(store, await nodeIdOf(store, `${key}-${String(seq)}`), { lifecycle });
}

async function reload(key: string, seq: number) {
  const id = await nodeIdOf(store, `${key}-${String(seq)}`);
  const node = await store.transact((w) => w.loadNode(id));
  if (node === undefined) {
    throw new Error(`node ${key}-${String(seq)} vanished`);
  }
  return node;
}

async function dep(key: string, nodeSeq: number, dependsOnSeq: number): Promise<void> {
  const nodeId = await nodeIdOf(store, `${key}-${String(nodeSeq)}`);
  const dependsOnId = await nodeIdOf(store, `${key}-${String(dependsOnSeq)}`);
  await rawDep(store, nodeId, dependsOnId);
}

test.skipIf(!NORN)(
  'an initiative-level prerequisite gates a deep task and rolls the phase up to awaiting',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'dependent init' });
    const prereqInit = await createInitiative(store, { projectId, title: 'prereq init' });
    const prereqTask = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(prereqInit.seq)}`),
      title: 'prereq work',
    });
    await dep('MMR', init.seq, prereqInit.seq); // edge two levels above the leaf

    const phase = await createPhase(store, {
      parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
      title: 'ph',
    });
    const deep = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
      title: 'deep',
    });

    // inherited across two levels (deep → phase → init), and the phase rolls up awaiting
    expect(nodeStatusWord(await setOf(), await reload('MMR', deep.seq))).toBe('awaiting');
    expect(nodeStatusWord(await setOf(), await reload('MMR', phase.seq))).toBe('awaiting');

    // the prerequisite initiative settles → the gate clears, top to bottom
    await setLifecycle('MMR', prereqTask.seq, 'done');
    expect(nodeStatusWord(await setOf(), await reload('MMR', deep.seq))).toBe('ready');
    expect(nodeStatusWord(await setOf(), await reload('MMR', phase.seq))).toBe('ready');
  },
);

test.skipIf(!NORN)(
  'an inherited gate is advisory: a started descendant stays in_progress',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
    const phase1 = await createPhase(store, { parentId: initId, title: 'phase 1' });
    await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(phase1.seq)}`),
      title: 'p1 work',
    }); // keeps phase 1 unsettled
    const phase2 = await createPhase(store, { parentId: initId, title: 'phase 2' });
    await dep('MMR', phase2.seq, phase1.seq);
    const started = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(phase2.seq)}`),
      title: 'started early',
    });

    // gate governs picking up new work, not retroactively un-starting active work
    await setLifecycle('MMR', started.seq, 'in_progress');
    expect(nodeStatusWord(await setOf(), await reload('MMR', started.seq))).toBe('in_progress');
    // and the phase reads in_progress (live work beats the gate) — honest
    expect(nodeStatusWord(await setOf(), await reload('MMR', phase2.seq))).toBe('in_progress');
  },
);

test.skipIf(!NORN)('a fresh phase of todo tasks rolls up to ready', async () => {
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  await createTask(store, { parentId: phaseId, title: 't1' });
  await createTask(store, { parentId: phaseId, title: 't2' });

  expect(childDistribution(await setOf(), phaseId)).toEqual({ ready: 2 });
  expect(statusOf(await setOf(), await reload('MMR', phase.seq)).status).toBe('ready');
  // initiative tallies the phase's word
  expect(statusOf(await setOf(), await reload('MMR', init.seq)).status).toBe('ready');
});

test.skipIf(!NORN)('live work beats ready in the rollup', async () => {
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  const t1 = await createTask(store, { parentId: phaseId, title: 't1' });
  await createTask(store, { parentId: phaseId, title: 't2' });

  await setLifecycle('MMR', t1.seq, 'in_progress');
  expect(childDistribution(await setOf(), phaseId)).toEqual({ in_progress: 1, ready: 1 });
  expect(statusOf(await setOf(), await reload('MMR', phase.seq)).status).toBe('in_progress');
});

test.skipIf(!NORN)('all-done rolls up to done; an empty phase is new', async () => {
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  const t1 = await createTask(store, {
    parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
    title: 't1',
  });
  await setLifecycle('MMR', t1.seq, 'done');
  expect(statusOf(await setOf(), await reload('MMR', phase.seq)).status).toBe('done');

  const empty = await createPhase(store, { parentId: initId, title: 'empty' });
  expect(statusOf(await setOf(), await reload('MMR', empty.seq)).status).toBe('new');

  // initiative over [done phase, new phase] → new (only undefined chunks remain after terminal)
  expect(statusOf(await setOf(), await reload('MMR', init.seq)).status).toBe('new');
});

test.skipIf(!NORN)(
  'a task awaits an unsettled prerequisite and becomes ready once it settles',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const phase = await createPhase(store, {
      parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
      title: 'ph',
    });
    const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
    const prereq = await createTask(store, { parentId: phaseId, title: 'prereq' });
    const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
    await dep('MMR', dependent.seq, prereq.seq);

    expect(nodeStatusWord(await setOf(), await reload('MMR', dependent.seq))).toBe('awaiting');

    await setLifecycle('MMR', prereq.seq, 'done');
    expect(nodeStatusWord(await setOf(), await reload('MMR', dependent.seq))).toBe('ready');

    // an abandoned prerequisite also settles the dependent (abandoned never freezes)
    const prereq2 = await createTask(store, { parentId: phaseId, title: 'prereq2' });
    await dep('MMR', dependent.seq, prereq2.seq);
    expect(nodeStatusWord(await setOf(), await reload('MMR', dependent.seq))).toBe('awaiting');
    await setLifecycle('MMR', prereq2.seq, 'abandoned');
    expect(nodeStatusWord(await setOf(), await reload('MMR', dependent.seq))).toBe('ready');
  },
);

test.skipIf(!NORN)(
  'a container-dependency loop written behind the verbs throws the cycle invariant',
  async () => {
    // The depend/move guards reject this shape at write time (MMR-140); write the
    // raw edge to pin the read-side detection for data that predates the guards.
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const initA = await createInitiative(store, { projectId, title: 'A' });
    const b = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(initA.seq)}`),
      title: 'b',
    });
    const initC = await createInitiative(store, { projectId, title: 'C' });
    const d = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(initC.seq)}`),
      title: 'd',
    });
    await dep('MMR', b.seq, initC.seq); // A's task awaits C's rollup
    await dep('MMR', d.seq, initA.seq); // C's task awaits A's rollup — the loop

    const set = await setOf();
    const node = await reload('MMR', b.seq);
    expect(() => nodeStatusWord(set, node)).toThrow(/derivation cycle/);
  },
);

// ── Open-ended containers (MMR-204) ──────────────────────────────────────────

async function setOpenEnded(key: string, seq: number, value: boolean): Promise<void> {
  await rawPatchNode(store, await nodeIdOf(store, `${key}-${String(seq)}`), { open_ended: value });
}

test.skipIf(!NORN)(
  'open-ended: a container with all children terminal reads ready, not done',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const phase = await createPhase(store, {
      parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
      title: 'bugs',
    });
    const t = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
      title: 't',
    });
    await setLifecycle('MMR', t.seq, 'done');
    await setOpenEnded('MMR', phase.seq, true);

    // a normal phase would read `done` here; open-ended stays open for filing
    expect(nodeStatusWord(await setOf(), await reload('MMR', phase.seq))).toBe('ready');
  },
);

test.skipIf(!NORN)('open-ended: an empty container reads ready, not new', async () => {
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'standing',
  });
  await setOpenEnded('MMR', phase.seq, true);

  expect(nodeStatusWord(await setOf(), await reload('MMR', phase.seq))).toBe('ready');
});

test.skipIf(!NORN)(
  'open-ended: a container with live children derives its normal word',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const phase = await createPhase(store, {
      parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
      title: 'bugs',
    });
    const t = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
      title: 't',
    });
    await setLifecycle('MMR', t.seq, 'in_progress');
    await setOpenEnded('MMR', phase.seq, true);

    expect(nodeStatusWord(await setOf(), await reload('MMR', phase.seq))).toBe('in_progress');
  },
);

test.skipIf(!NORN)(
  'open-ended: an idle container is excluded from its parent rollup so the parent can close',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
    const donePhase = await createPhase(store, { parentId: initId, title: 'done work' });
    const dt = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(donePhase.seq)}`),
      title: 'dt',
    });
    await setLifecycle('MMR', dt.seq, 'done');
    const standing = await createPhase(store, { parentId: initId, title: 'bugs' });
    await setOpenEnded('MMR', standing.seq, true); // empty + open-ended → idle

    // the idle open-ended phase drops out of the tally; only the done phase remains
    expect(childDistribution(await setOf(), initId)).toEqual({ done: 1 });
    expect(nodeStatusWord(await setOf(), await reload('MMR', init.seq))).toBe('done');
  },
);

test.skipIf(!NORN)(
  'open-ended: a container with live children contributes its word to the parent',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
    const donePhase = await createPhase(store, { parentId: initId, title: 'done work' });
    const dt = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(donePhase.seq)}`),
      title: 'dt',
    });
    await setLifecycle('MMR', dt.seq, 'done');
    const standing = await createPhase(store, { parentId: initId, title: 'bugs' });
    const live = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(standing.seq)}`),
      title: 'bug',
    });
    await setLifecycle('MMR', live.seq, 'in_progress');
    await setOpenEnded('MMR', standing.seq, true);

    // live children → contributes in_progress; parent stays open
    expect(childDistribution(await setOf(), initId)).toEqual({ done: 1, in_progress: 1 });
    expect(nodeStatusWord(await setOf(), await reload('MMR', init.seq))).toBe('in_progress');
  },
);

test.skipIf(!NORN)(
  'open-ended: a container never satisfies a dependency, even when it displays ready (MMR-204)',
  async () => {
    await createProject(store, { key: 'MMR', name: 'm' });
    const projectId = await projectIdOf(store, 'MMR');
    const init = await createInitiative(store, { projectId, title: 'i' });
    const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
    // prerequisite: an idle open-ended phase (one done child → displays ready)
    const prereq = await createPhase(store, { parentId: initId, title: 'bugs' });
    const bug = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(prereq.seq)}`),
      title: 'bug',
    });
    await setLifecycle('MMR', bug.seq, 'done');
    await setOpenEnded('MMR', prereq.seq, true);
    // a dependent in a sibling phase depends on the standing container
    const work = await createPhase(store, { parentId: initId, title: 'work' });
    const after = await createTask(store, {
      parentId: await nodeIdOf(store, `MMR-${String(work.seq)}`),
      title: 'after bugs',
    });
    await dep('MMR', after.seq, prereq.seq);

    // the prereq shows `ready`, but a standing home never settles → the dependent awaits
    expect(nodeStatusWord(await setOf(), await reload('MMR', prereq.seq))).toBe('ready');
    expect(nodeStatusWord(await setOf(), await reload('MMR', after.seq))).toBe('awaiting');
  },
);
