import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { deriveSet } from '../derive';
import { isReady } from '../predicates';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { archiveProject, releasedByArchive, unarchiveProject } from './archive';
import { annotate, attachArtifact, updateNode, updateProject } from './data';
import { depend } from './dependency';
import { completeTask, startTask } from './lifecycle';
import { moveNode } from './structure';
import { tagEntities } from './tags';

const NORN = Bun.which('norn') !== null;

/** Readiness of a task by its surrogate id (loads the row first). */
async function ready(id: number): Promise<boolean> {
  const node = await store.transact((w) => w.loadNode(id));
  return node === undefined ? false : isReady(await setOf(), node);
}

/**
 * Project archive (ADR 0015): a reversible, reason-bearing project axis that
 * freezes the whole subtree. These cover the write-lock choke point (no
 * mutation under an archived project), the logged transition, reversibility,
 * idempotency, and isolation from sibling projects.
 */

let store: Store;
let closeStore: () => Promise<void>;
// The MMR fixture's node identities are threaded as `KEY-seq` (via seq),
// never as a cached numeric id: over Norn a surrogate id is per-load, and
// several tests below create a second project mid-test, which re-mints every
// id in the vault — so the project/phase/task id is always resolved fresh,
// right before use, from these stable seqs.
let mmrPhaseSeq: number;
let mmrTaskSeq: number;
const projectId = () => projectIdOf(store, 'MMR');
const phaseId = () => nodeIdOf(store, `MMR-${String(mmrPhaseSeq)}`);
const taskId = () => nodeIdOf(store, `MMR-${String(mmrTaskSeq)}`);

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: await projectId(), title: 'i' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(init.seq)}`),
    title: 'ph',
  });
  mmrPhaseSeq = phase.seq;
  const task = await createTask(store, { parentId: await phaseId(), title: 't' });
  mmrTaskSeq = task.seq;
});
afterEach(async () => {
  await closeStore();
});

const setOf = async () => deriveSet(await store.loadWorkingSet());

test.skipIf(!NORN)(
  'archive sets archived_at and logs a project-keyed transition with the reason',
  async () => {
    const project = await archiveProject(store, await projectId(), 'superseded by SAGA2');
    expect(project.archived_at).not.toBeNull();

    const { items } = await store.transitions.list();
    const rows = items.filter((i) => i.kind === 'archive');
    expect(rows).toHaveLength(1);
    // A project-keyed transition's `node` is the project's KEY (not a KEY-seq
    // node stem) — the Norn-native equivalent of the old project_id/node_id split.
    expect(rows[0]?.node).toBe('MMR');
    expect(rows[0]?.from).toBe('active');
    expect(rows[0]?.to).toBe('archived');
    expect(rows[0]?.reason).toBe('superseded by SAGA2');
  },
);

test.skipIf(!NORN)(
  'archive freezes every mutation under the project (the write-lock)',
  async () => {
    await archiveProject(store, await projectId());

    // node-targeting verbs (guarded via requireNode/requireTask)
    await expectMimirError('conflict', async () => startTask(store, await taskId()));
    await expectMimirError('conflict', async () =>
      updateNode(store, await taskId(), { priority: 'p1' }),
    );
    await expectMimirError('conflict', async () => annotate(store, await taskId(), 'note'));
    await expectMimirError('conflict', async () =>
      moveNode(store, await taskId(), await phaseId()),
    );

    // create under the archived project (guarded via assertProjectActive)
    await expectMimirError('conflict', async () =>
      createTask(store, { parentId: await phaseId(), title: 'x' }),
    );
    await expectMimirError('conflict', async () =>
      createInitiative(store, { projectId: await projectId(), title: 'x' }),
    );

    // project-level + attach + tag paths
    await expectMimirError('conflict', async () =>
      updateProject(store, await projectId(), { name: 'new' }),
    );
    await expectMimirError('conflict', async () =>
      attachArtifact(store, { content: 'c', projectId: await projectId(), title: 'a' }),
    );
    await expectMimirError('conflict', async () =>
      tagEntities(store, [{ entityId: await taskId(), entityType: 'node' }], ['tag']),
    );
    await expectMimirError('conflict', async () =>
      tagEntities(store, [{ entityId: await projectId(), entityType: 'project' }], ['tag']),
    );
  },
);

test.skipIf(!NORN)(
  'unarchive clears archived_at, logs the reverse transition, and re-enables mutation',
  async () => {
    await archiveProject(store, await projectId());
    const project = await unarchiveProject(store, await projectId());
    expect(project.archived_at).toBeNull();

    const { items } = await store.transitions.list();
    const rows = items.filter((i) => i.kind === 'archive');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.from).toBe('archived');
    expect(rows[1]?.to).toBe('active');

    // mutation works again
    const task = await startTask(store, await taskId());
    expect(task.lifecycle).toBe('in_progress');
  },
);

test.skipIf(!NORN)('archive/unarchive idempotency is a conflict, not a silent no-op', async () => {
  await archiveProject(store, await projectId());
  await expectMimirError('conflict', async () => archiveProject(store, await projectId()));

  await unarchiveProject(store, await projectId());
  await expectMimirError('conflict', async () => unarchiveProject(store, await projectId()));
});

test.skipIf(!NORN)('archiving one project leaves a sibling project fully mutable', async () => {
  await createProject(store, { key: 'OTH', name: 'o' });
  const otherProjectId = await projectIdOf(store, 'OTH');
  const otherInit = await createInitiative(store, { projectId: otherProjectId, title: 'i' });
  const otherInitId = await nodeIdOf(store, `OTH-${String(otherInit.seq)}`);
  const otherPhase = await createPhase(store, { parentId: otherInitId, title: 'ph' });
  const otherPhaseId = await nodeIdOf(store, `OTH-${String(otherPhase.seq)}`);
  const otherTask = await createTask(store, { parentId: otherPhaseId, title: 't' });
  const otherTaskId = await nodeIdOf(store, `OTH-${String(otherTask.seq)}`);

  await archiveProject(store, await projectId());

  // the sibling is unaffected
  const started = await startTask(store, otherTaskId);
  expect(started.lifecycle).toBe('in_progress');
});

// --- archived prerequisite settles downstream gating (ADR 0015 Refinement, MMR-124) ---

test.skipIf(!NORN)(
  'archiving a project settles its nodes as prerequisites — the dependent is released',
  async () => {
    // AAA task depends on a task in the MMR project (a cross-project edge).
    await createProject(store, { key: 'AAA', name: 'a' });
    const aaaId = await projectIdOf(store, 'AAA');
    const aInit = await createInitiative(store, { projectId: aaaId, title: 'i' });
    const aInitId = await nodeIdOf(store, `AAA-${String(aInit.seq)}`);
    const aPhase = await createPhase(store, { parentId: aInitId, title: 'ph' });
    const aPhaseId = await nodeIdOf(store, `AAA-${String(aPhase.seq)}`);
    const a1 = await createTask(store, { parentId: aPhaseId, title: 'a1' });
    const a1Id = await nodeIdOf(store, `AAA-${String(a1.seq)}`);
    await depend(store, a1Id, [await taskId()]);

    // Gated: the prerequisite (in MMR) is unsettled, so a1 is awaiting, not ready.
    expect(await ready(a1Id)).toBe(false);

    // Archiving MMR settles the prerequisite → a1 is released (ready).
    await archiveProject(store, await projectId());
    expect(await ready(a1Id)).toBe(true);

    // Unarchiving re-gates it — no edge was mutated, so the gate returns.
    await unarchiveProject(store, await projectId());
    expect(await ready(a1Id)).toBe(false);
  },
);

test.skipIf(!NORN)(
  'releasedByArchive reports only genuinely-released out-of-project leaf tasks',
  async () => {
    await createProject(store, { key: 'AAA', name: 'a' });
    const aaaId = await projectIdOf(store, 'AAA');
    const aInit = await createInitiative(store, { projectId: aaaId, title: 'i' });
    const aInitId = await nodeIdOf(store, `AAA-${String(aInit.seq)}`);
    const aPhase = await createPhase(store, { parentId: aInitId, title: 'ph' });
    const aPhaseId = await nodeIdOf(store, `AAA-${String(aPhase.seq)}`);

    // (1) released: depends only on the MMR task → becomes ready when MMR archives.
    const freed = await createTask(store, { parentId: aPhaseId, title: 'freed' });
    const freedId = await nodeIdOf(store, `AAA-${String(freed.seq)}`);
    await depend(store, freedId, [await taskId()]);

    // (2) NOT released: also depends on a live AAA task → stays awaiting (multi-prereq).
    const liveDep = await createTask(store, { parentId: aPhaseId, title: 'live prereq' });
    const liveDepId = await nodeIdOf(store, `AAA-${String(liveDep.seq)}`);
    const stillAwaiting = await createTask(store, {
      parentId: aPhaseId,
      title: 'still awaiting',
    });
    const stillAwaitingId = await nodeIdOf(store, `AAA-${String(stillAwaiting.seq)}`);
    await depend(store, stillAwaitingId, [await taskId(), liveDepId]);

    // (3) NOT reported: an in-project dependent (another MMR task).
    const sibling = await createTask(store, { parentId: await phaseId(), title: 'sib' });
    const siblingId = await nodeIdOf(store, `MMR-${String(sibling.seq)}`);
    await depend(store, siblingId, [await taskId()]);

    await archiveProject(store, await projectId());
    const released = await releasedByArchive(store, await projectId());
    expect(released).toEqual([`AAA-${String(freed.seq)}`]);
  },
);

test.skipIf(!NORN)(
  'releasedByArchive is empty when the archived prereqs were already settled',
  async () => {
    // A dependent on a DONE prereq is already ready — archiving does not release it.
    await createProject(store, { key: 'AAA', name: 'a' });
    const aaaId = await projectIdOf(store, 'AAA');
    const aInit = await createInitiative(store, { projectId: aaaId, title: 'i' });
    const aInitId = await nodeIdOf(store, `AAA-${String(aInit.seq)}`);
    const aPhase = await createPhase(store, { parentId: aInitId, title: 'ph' });
    const aPhaseId = await nodeIdOf(store, `AAA-${String(aPhase.seq)}`);
    const dep = await createTask(store, { parentId: aPhaseId, title: 'dep' });
    const depId = await nodeIdOf(store, `AAA-${String(dep.seq)}`);
    await depend(store, depId, [await taskId()]);
    await startTask(store, await taskId());
    await completeTask(store, await taskId()); // MMR task done → dep already ready

    await archiveProject(store, await projectId());
    expect(await releasedByArchive(store, await projectId())).toEqual([]);
  },
);
