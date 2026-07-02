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
  listNodes,
  listProjects,
  nextTasks,
  nodeTree,
  projectTree,
  statusOfNode,
  unarchiveProject,
} from './index';
import type { Store } from './store';
import { createSqliteStore } from './store-sqlite';
import { expectMimirError } from './testing';

/**
 * Read-side hiding (ADR 0015 Phase 1): an archived project + its whole subtree
 * + artifacts read as absent by default across every read path; a project-level
 * `--status archived` door is the sole opt-in. `unarchive` restores visibility.
 */

let db: Db;
let store: Store;
let gonProjectId: number;
let gonTaskId: string;
let gonTaskNumId: number;
let gonArtifactId: string;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  // A project we keep, and one we'll archive.
  const kep = await createProject(store, { key: 'KEP', name: 'keep' });
  const kInit = await createInitiative(store, { projectId: kep.id, title: 'i' });
  const kPhase = await createPhase(store, { parentId: kInit.id, title: 'ph' });
  await createTask(store, { parentId: kPhase.id, title: 'kep task' });

  const gon = await createProject(store, { key: 'GON', name: 'gone' });
  gonProjectId = gon.id;
  const gInit = await createInitiative(store, { projectId: gon.id, title: 'i' });
  const gPhase = await createPhase(store, { parentId: gInit.id, title: 'ph' });
  const gTask = await createTask(store, { parentId: gPhase.id, title: 'gon task' });
  gonTaskId = `GON-${String(gTask.seq)}`;
  gonTaskNumId = gTask.id;
  const art = await attachArtifact(store, {
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
  const before = await listNodes(createSqliteStore(db), { status: 'all' });
  expect(before.items.some((n) => n.id === gonTaskId)).toBe(true);

  await archiveProject(store, gonProjectId);

  const list = await listNodes(createSqliteStore(db), { status: 'all' });
  expect(list.items.some((n) => n.id === gonTaskId)).toBe(false);
  expect(list.items.some((n) => n.id.startsWith('KEP-'))).toBe(true); // sibling still visible

  const next = await nextTasks(createSqliteStore(db), {});
  expect(next.items.some((n) => n.id.startsWith('GON-'))).toBe(false);
});

test('get / status / tree / getArtifact on an archived target read as not_found', async () => {
  await archiveProject(store, gonProjectId);
  await expectMimirError('not_found', () => getNode(store, 'GON')); // the project
  await expectMimirError('not_found', () => getNode(store, gonTaskId)); // a node under it
  await expectMimirError('not_found', () => statusOfNode(db, 'GON'));
  await expectMimirError('not_found', () => statusOfNode(db, gonTaskId));
  await expectMimirError('not_found', () => nodeTree(store, gonTaskId));
  await expectMimirError('not_found', () => projectTree(store, 'GON'));
  await expectMimirError('not_found', () => getArtifact(store, gonArtifactId));
});

test('listProjects hides archived by default; the door reveals only archived', async () => {
  await archiveProject(store, gonProjectId);

  const active = await listProjects(store);
  expect(active.map((p) => p.id).toSorted()).toEqual(['KEP']);

  const archived = await listProjects(store, undefined, 'archived');
  expect(archived.map((p) => p.id)).toEqual(['GON']);

  const all = await listProjects(store, undefined, 'all');
  expect(all.map((p) => p.id).toSorted()).toEqual(['GON', 'KEP']);
});

test('the artifact feed excludes an archived project’s artifacts', async () => {
  const archivedKeys = async (): Promise<string[]> => {
    const ws = await store.loadWorkingSet();
    return ws.projects.filter((p) => p.archived_at !== null).map((p) => p.key);
  };
  const before = await store.artifacts.list({ excludeProjects: await archivedKeys() });
  expect(before.total).toBe(1);

  await archiveProject(store, gonProjectId);
  const after = await store.artifacts.list({ excludeProjects: await archivedKeys() });
  expect(after.total).toBe(0);
});

test('the deps facet does not leak archived nodes across a cross-project edge', async () => {
  // Active AAA with two tasks + a cross-project edge each way into the GON task.
  const aaa = await createProject(store, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(store, { projectId: aaa.id, title: 'i' });
  const aPhase = await createPhase(store, { parentId: aInit.id, title: 'ph' });
  const a1 = await createTask(store, { parentId: aPhase.id, title: 'a1' });
  const a2 = await createTask(store, { parentId: aPhase.id, title: 'a2' });
  await depend(store, a1.id, [gonTaskNumId]); // a1 depends on the GON task (dependsOn/awaitingOn)
  await depend(store, gonTaskNumId, [a2.id]); // the GON task depends on a2 (a2 blocking)

  await archiveProject(store, gonProjectId);

  const a1View = await getNode(store, `AAA-${String(a1.seq)}`, { facets: ['deps'] });
  const shown = [...(a1View.deps?.dependsOn ?? []), ...(a1View.deps?.awaitingOn ?? [])];
  expect(shown.some((r) => r.id.startsWith('GON-'))).toBe(false);

  const a2View = await getNode(store, `AAA-${String(a2.seq)}`, { facets: ['deps'] });
  expect((a2View.deps?.blocking ?? []).some((r) => r.id.startsWith('GON-'))).toBe(false);
});

test('unarchive restores full read visibility', async () => {
  await archiveProject(store, gonProjectId);
  await unarchiveProject(store, gonProjectId);

  const list = await listNodes(createSqliteStore(db), { status: 'all' });
  expect(list.items.some((n) => n.id === gonTaskId)).toBe(true);
  expect((await getNode(store, 'GON')).id).toBe('GON');
  expect((await listProjects(store)).map((p) => p.id).toSorted()).toEqual(['GON', 'KEP']);
});
