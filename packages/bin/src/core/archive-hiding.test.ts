import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import {
  archiveProject,
  attachArtifact,
  depend,
  getArtifact,
  getNode,
  listArtifacts,
  listNodes,
  listProjects,
  nextTasks,
  nodeTree,
  projectTree,
  statusOfNode,
  unarchiveProject,
} from './index';
import { expectMimirError } from './testing';

/**
 * Read-side hiding (ADR 0015 Phase 1): an archived project + its whole subtree
 * + artifacts read as absent by default across every read path; a project-level
 * `--status archived` door is the sole opt-in. `unarchive` restores visibility.
 */

let db: Db;
let gonProjectId: number;
let gonTaskId: string;
let gonTaskNumId: number;
let gonArtifactId: string;
beforeEach(async () => {
  db = await createTestDb();
  // A project we keep, and one we'll archive.
  const kep = await createProject(db, { key: 'KEP', name: 'keep' });
  const kInit = await createInitiative(db, { projectId: kep.id, title: 'i' });
  const kPhase = await createPhase(db, { parentId: kInit.id, title: 'ph' });
  await createTask(db, { parentId: kPhase.id, title: 'kep task' });

  const gon = await createProject(db, { key: 'GON', name: 'gone' });
  gonProjectId = gon.id;
  const gInit = await createInitiative(db, { projectId: gon.id, title: 'i' });
  const gPhase = await createPhase(db, { parentId: gInit.id, title: 'ph' });
  const gTask = await createTask(db, { parentId: gPhase.id, title: 'gon task' });
  gonTaskId = `GON-${String(gTask.seq)}`;
  gonTaskNumId = gTask.id;
  const art = await attachArtifact(db, {
    content: 'spec',
    linkNodeIds: [gTask.id],
    projectId: gon.id,
    title: 'a',
  });
  gonArtifactId = art.renderedId;
});
afterEach(async () => {
  await db.destroy();
});

test('next and list exclude an archived project’s subtree', async () => {
  const before = await listNodes(db, { status: 'all' });
  expect(before.items.some((n) => n.id === gonTaskId)).toBe(true);

  await archiveProject(db, gonProjectId);

  const list = await listNodes(db, { status: 'all' });
  expect(list.items.some((n) => n.id === gonTaskId)).toBe(false);
  expect(list.items.some((n) => n.id.startsWith('KEP-'))).toBe(true); // sibling still visible

  const next = await nextTasks(db, {});
  expect(next.items.some((n) => n.id.startsWith('GON-'))).toBe(false);
});

test('get / status / tree / getArtifact on an archived target read as not_found', async () => {
  await archiveProject(db, gonProjectId);
  await expectMimirError('not_found', () => getNode(db, 'GON')); // the project
  await expectMimirError('not_found', () => getNode(db, gonTaskId)); // a node under it
  await expectMimirError('not_found', () => statusOfNode(db, 'GON'));
  await expectMimirError('not_found', () => statusOfNode(db, gonTaskId));
  await expectMimirError('not_found', () => nodeTree(db, gonTaskId));
  await expectMimirError('not_found', () => projectTree(db, 'GON'));
  await expectMimirError('not_found', () => getArtifact(db, gonArtifactId));
});

test('listProjects hides archived by default; the door reveals only archived', async () => {
  await archiveProject(db, gonProjectId);

  const active = await listProjects(db);
  expect(active.map((p) => p.id).toSorted()).toEqual(['KEP']);

  const archived = await listProjects(db, undefined, 'archived');
  expect(archived.map((p) => p.id)).toEqual(['GON']);

  const all = await listProjects(db, undefined, 'all');
  expect(all.map((p) => p.id).toSorted()).toEqual(['GON', 'KEP']);
});

test('listArtifacts excludes an archived project’s artifacts', async () => {
  const before = await listArtifacts(db);
  expect(before.total).toBe(1);

  await archiveProject(db, gonProjectId);
  const after = await listArtifacts(db);
  expect(after.total).toBe(0);
});

test('the deps facet does not leak archived nodes across a cross-project edge', async () => {
  // Active AAA with two tasks + a cross-project edge each way into the GON task.
  const aaa = await createProject(db, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(db, { projectId: aaa.id, title: 'i' });
  const aPhase = await createPhase(db, { parentId: aInit.id, title: 'ph' });
  const a1 = await createTask(db, { parentId: aPhase.id, title: 'a1' });
  const a2 = await createTask(db, { parentId: aPhase.id, title: 'a2' });
  await depend(db, a1.id, [gonTaskNumId]); // a1 depends on the GON task (dependsOn/awaitingOn)
  await depend(db, gonTaskNumId, [a2.id]); // the GON task depends on a2 (a2 blocking)

  await archiveProject(db, gonProjectId);

  const a1View = await getNode(db, `AAA-${String(a1.seq)}`, { facets: ['deps'] });
  const shown = [...(a1View.deps?.dependsOn ?? []), ...(a1View.deps?.awaitingOn ?? [])];
  expect(shown.some((r) => r.id.startsWith('GON-'))).toBe(false);

  const a2View = await getNode(db, `AAA-${String(a2.seq)}`, { facets: ['deps'] });
  expect((a2View.deps?.blocking ?? []).some((r) => r.id.startsWith('GON-'))).toBe(false);
});

test('unarchive restores full read visibility', async () => {
  await archiveProject(db, gonProjectId);
  await unarchiveProject(db, gonProjectId);

  const list = await listNodes(db, { status: 'all' });
  expect(list.items.some((n) => n.id === gonTaskId)).toBe(true);
  expect((await getNode(db, 'GON')).id).toBe('GON');
  expect((await listProjects(db)).map((p) => p.id).toSorted()).toEqual(['GON', 'KEP']);
});
