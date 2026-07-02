import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../db/testing';
import type { Db } from './context';
import { createInitiative, createProject, createTask } from './create';
import { validation } from './errors';
import { archiveProject } from './mutations/archive';
import { depend } from './mutations/dependency';
import { createSqliteStore } from './store-sqlite';
import { expectMimirError } from './testing';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.destroy();
});

const byId = (x: number, y: number): number => x - y;

test('loadWorkingSet returns the whole store: nodes and cross-project edges in one projection', async () => {
  const a = await createProject(db, { key: 'AA', name: 'a' });
  const b = await createProject(db, { key: 'BB', name: 'b' });
  const initA = await createInitiative(db, { projectId: a.id, title: 'ia' });
  const initB = await createInitiative(db, { projectId: b.id, title: 'ib' });
  const upstream = await createTask(db, { parentId: initA.id, title: 'upstream' });
  const downstream = await createTask(db, { parentId: initB.id, title: 'downstream' });
  await depend(db, downstream.id, [upstream.id]);

  const ws = await createSqliteStore(db).loadWorkingSet();

  expect(ws.projects.map((p) => p.key)).toEqual(['AA', 'BB']);
  const taskIds = ws.nodes.filter((n) => n.type === 'task').map((n) => n.id);
  expect(taskIds.toSorted(byId)).toEqual([upstream.id, downstream.id].toSorted(byId));
  // the cross-project edge is present — a scoped load would lose it
  expect(ws.edges).toEqual([{ depends_on_node_id: upstream.id, node_id: downstream.id }]);
});

test('archived projects stay in the working set with the archived axis readable', async () => {
  const live = await createProject(db, { key: 'AA', name: 'live' });
  const dead = await createProject(db, { key: 'BB', name: 'dead' });
  const deadInit = await createInitiative(db, { projectId: dead.id, title: 'di' });
  await createTask(db, { parentId: deadInit.id, title: 'frozen' });
  await archiveProject(db, dead.id, 'superseded');

  const ws = await createSqliteStore(db).loadWorkingSet();

  const byKey = new Map(ws.projects.map((p) => [p.key, p]));
  expect(byKey.get('AA')?.archived_at).toBeNull();
  expect(byKey.get('BB')?.archived_at).not.toBeNull();
  // the archived project's nodes are in the set — hiding is the consumer's cut
  expect(ws.nodes.filter((n) => n.project_id === live.id)).toHaveLength(0);
  expect(ws.nodes.filter((n) => n.project_id === dead.id)).toHaveLength(2);
});

test('nodeTags carries node tags in created_at order and omits untagged nodes', async () => {
  const p = await createProject(db, { key: 'AA', name: 'a' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const tagged = await createTask(db, { parentId: init.id, title: 'tagged' });
  const bare = await createTask(db, { parentId: init.id, title: 'bare' });
  await db
    .insertInto('tag')
    .values([
      {
        created_at: '2026-01-01T00:00:00.000Z',
        entity_id: tagged.id,
        entity_type: 'node',
        tag: 'later',
      },
      {
        created_at: '2025-01-01T00:00:00.000Z',
        entity_id: tagged.id,
        entity_type: 'node',
        tag: 'earlier',
      },
    ])
    .execute();
  // a project-tag with a colliding entity id must not leak into node tags
  await db
    .insertInto('tag')
    .values({ entity_id: p.id, entity_type: 'project', tag: 'proj' })
    .execute();

  const ws = await createSqliteStore(db).loadWorkingSet();

  expect((ws.nodeTags.get(tagged.id) ?? []).map((t) => t.tag)).toEqual(['earlier', 'later']);
  expect(ws.nodeTags.get(tagged.id)?.[0]).toEqual({
    created_at: '2025-01-01T00:00:00.000Z',
    note: null,
    tag: 'earlier',
  });
  expect(ws.nodeTags.has(bare.id)).toBe(false);
  expect([...ws.nodeTags.values()].flat().map((t) => t.tag)).not.toContain('proj');
});

test('transact rolls the whole scope back on a throw — no partial rows survive', async () => {
  const store = createSqliteStore(db);
  const project = await store.transact((w) =>
    w.insertProject({ description: null, key: 'AA', name: 'a' }),
  );

  await expectMimirError('validation', () =>
    store.transact(async (w) => {
      const seq = await w.allocateSeq(project.id);
      await w.insertNode({
        description: null,
        parent_id: null,
        project_id: project.id,
        seq,
        title: 'orphaned by the rollback',
        type: 'initiative',
      });
      throw validation('mid-verb invariant');
    }),
  );

  const ws = await store.loadWorkingSet();
  expect(ws.nodes).toHaveLength(0);
  // the seq allocation rolled back with the insert — nothing leaks
  expect(ws.projects[0]?.last_seq).toBe(0);
});

test('the writer sees its own in-tx writes — snapshot and point read alike', async () => {
  const store = createSqliteStore(db);
  const { nodeId, snapshotIds, reloaded } = await store.transact(async (w) => {
    const project = await w.insertProject({ description: null, key: 'AA', name: 'a' });
    const seq = await w.allocateSeq(project.id);
    const node = await w.insertNode({
      description: null,
      parent_id: null,
      project_id: project.id,
      seq,
      title: 'i',
      type: 'initiative',
    });
    const ws = await w.loadWorkingSet();
    return {
      nodeId: node.id,
      reloaded: await w.loadNode(node.id),
      snapshotIds: ws.nodes.map((n) => n.id),
    };
  });
  expect(reloaded?.title).toBe('i');
  expect(reloaded?.id).toBe(nodeId);
  expect(snapshotIds).toEqual([nodeId]);
});
