import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { deriveSet } from '../derive';
import { isReady } from '../predicates';
import type { Store } from '../store';
import { createSqliteStore, loadWorkingSet } from '../store-sqlite';
import { expectMimirError } from '../testing';
import { archiveProject, releasedByArchive, unarchiveProject } from './archive';
import { annotate, attachArtifact, updateNode, updateProject } from './data';
import { depend } from './dependency';
import { completeTask, startTask } from './lifecycle';
import { moveNode } from './structure';
import { tagEntities } from './tags';

/** Readiness of a task by its surrogate id (loads the row first). */
async function ready(db: Db, id: number): Promise<boolean> {
  const node = await store.transact((w) => w.loadNode(id));
  return node === undefined ? false : isReady(await setOf(), node);
}

/**
 * Project archive (ADR 0015): a reversible, reason-bearing project axis that
 * freezes the whole subtree. These cover the write-lock choke point (no
 * mutation under an archived project), the logged transition, reversibility,
 * idempotency, and isolation from sibling projects.
 */

let db: Db;
let store: Store;
let projectId: number;
let phaseId: number;
let taskId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
  const task = await createTask(store, { parentId: phase.id, title: 't' });
  taskId = task.id;
});
afterEach(async () => {
  await db.destroy();
});

const setOf = async () => deriveSet(await loadWorkingSet(db));

test('archive sets archived_at and logs a project-keyed transition with the reason', async () => {
  const project = await archiveProject(store, projectId, 'superseded by SAGA2');
  expect(project.archived_at).not.toBeNull();

  const rows = await db
    .selectFrom('transition_log')
    .selectAll()
    .where('kind', '=', 'archive')
    .execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.project_id).toBe(projectId);
  expect(rows[0]?.node_id).toBeNull();
  expect(rows[0]?.from_value).toBe('active');
  expect(rows[0]?.to_value).toBe('archived');
  expect(rows[0]?.reason).toBe('superseded by SAGA2');
});

test('archive freezes every mutation under the project (the write-lock)', async () => {
  await archiveProject(store, projectId);

  // node-targeting verbs (guarded via requireNode/requireTask)
  await expectMimirError('conflict', () => startTask(store, taskId));
  await expectMimirError('conflict', () => updateNode(store, taskId, { priority: 'p1' }));
  await expectMimirError('conflict', () => annotate(store, taskId, 'note'));
  await expectMimirError('conflict', () => moveNode(store, taskId, phaseId));

  // create under the archived project (guarded via assertProjectActive)
  await expectMimirError('conflict', () => createTask(store, { parentId: phaseId, title: 'x' }));
  await expectMimirError('conflict', () => createInitiative(store, { projectId, title: 'x' }));

  // project-level + attach + tag paths
  await expectMimirError('conflict', () => updateProject(store, projectId, { name: 'new' }));
  await expectMimirError('conflict', () =>
    attachArtifact(store, { content: 'c', projectId, title: 'a' }),
  );
  await expectMimirError('conflict', () =>
    tagEntities(store, [{ entityId: taskId, entityType: 'node' }], ['tag']),
  );
  await expectMimirError('conflict', () =>
    tagEntities(store, [{ entityId: projectId, entityType: 'project' }], ['tag']),
  );
});

test('unarchive clears archived_at, logs the reverse transition, and re-enables mutation', async () => {
  await archiveProject(store, projectId);
  const project = await unarchiveProject(store, projectId);
  expect(project.archived_at).toBeNull();

  const rows = await db
    .selectFrom('transition_log')
    .selectAll()
    .where('kind', '=', 'archive')
    .orderBy('id', 'asc')
    .execute();
  expect(rows).toHaveLength(2);
  expect(rows[1]?.from_value).toBe('archived');
  expect(rows[1]?.to_value).toBe('active');

  // mutation works again
  const task = await startTask(store, taskId);
  expect(task.lifecycle).toBe('in_progress');
});

test('archive/unarchive idempotency is a conflict, not a silent no-op', async () => {
  await archiveProject(store, projectId);
  await expectMimirError('conflict', () => archiveProject(store, projectId));

  await unarchiveProject(store, projectId);
  await expectMimirError('conflict', () => unarchiveProject(store, projectId));
});

test('archiving one project leaves a sibling project fully mutable', async () => {
  const other = await createProject(store, { key: 'OTH', name: 'o' });
  const otherInit = await createInitiative(store, { projectId: other.id, title: 'i' });
  const otherPhase = await createPhase(store, { parentId: otherInit.id, title: 'ph' });
  const otherTask = await createTask(store, { parentId: otherPhase.id, title: 't' });

  await archiveProject(store, projectId);

  // the sibling is unaffected
  const started = await startTask(store, otherTask.id);
  expect(started.lifecycle).toBe('in_progress');
});

// --- archived prerequisite settles downstream gating (ADR 0015 Refinement, MMR-124) ---

test('archiving a project settles its nodes as prerequisites — the dependent is released', async () => {
  // AAA task depends on a task in the MMR project (a cross-project edge).
  const aaa = await createProject(store, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(store, { projectId: aaa.id, title: 'i' });
  const aPhase = await createPhase(store, { parentId: aInit.id, title: 'ph' });
  const a1 = await createTask(store, { parentId: aPhase.id, title: 'a1' });
  await depend(store, a1.id, [taskId]);

  // Gated: the prerequisite (in MMR) is unsettled, so a1 is awaiting, not ready.
  expect(await ready(db, a1.id)).toBe(false);

  // Archiving MMR settles the prerequisite → a1 is released (ready).
  await archiveProject(store, projectId);
  expect(await ready(db, a1.id)).toBe(true);

  // Unarchiving re-gates it — no edge was mutated, so the gate returns.
  await unarchiveProject(store, projectId);
  expect(await ready(db, a1.id)).toBe(false);
});

test('releasedByArchive reports only genuinely-released out-of-project leaf tasks', async () => {
  const aaa = await createProject(store, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(store, { projectId: aaa.id, title: 'i' });
  const aPhase = await createPhase(store, { parentId: aInit.id, title: 'ph' });

  // (1) released: depends only on the MMR task → becomes ready when MMR archives.
  const freed = await createTask(store, { parentId: aPhase.id, title: 'freed' });
  await depend(store, freed.id, [taskId]);

  // (2) NOT released: also depends on a live AAA task → stays awaiting (multi-prereq).
  const liveDep = await createTask(store, { parentId: aPhase.id, title: 'live prereq' });
  const stillAwaiting = await createTask(store, { parentId: aPhase.id, title: 'still awaiting' });
  await depend(store, stillAwaiting.id, [taskId, liveDep.id]);

  // (3) NOT reported: an in-project dependent (another MMR task).
  const sibling = await createTask(store, { parentId: phaseId, title: 'sib' });
  await depend(store, sibling.id, [taskId]);

  await archiveProject(store, projectId);
  const released = await releasedByArchive(store, projectId);
  expect(released).toEqual([`AAA-${String(freed.seq)}`]);
});

test('releasedByArchive is empty when the archived prereqs were already settled', async () => {
  // A dependent on a DONE prereq is already ready — archiving does not release it.
  const aaa = await createProject(store, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(store, { projectId: aaa.id, title: 'i' });
  const aPhase = await createPhase(store, { parentId: aInit.id, title: 'ph' });
  const dep = await createTask(store, { parentId: aPhase.id, title: 'dep' });
  await depend(store, dep.id, [taskId]);
  await startTask(store, taskId);
  await completeTask(store, taskId); // MMR task done → dep already ready

  await archiveProject(store, projectId);
  expect(await releasedByArchive(store, projectId)).toEqual([]);
});
