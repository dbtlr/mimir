import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { deriveSet } from '../derive';
import { resolveEntityTokenInSet } from '../resolve-set';
import type { Store } from '../store';
import { createSqliteStore } from '../store-sqlite';
import { expectMimirError } from '../testing';
import { attachArtifact } from './data';
import { tagEntities, untagEntities } from './tags';

let db: Db;
let store: Store;
let projectId: number;
let taskId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(store, { projectId, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  const task = await createTask(store, { parentId: phase.id, title: 't' });
  taskId = task.id;
});
afterEach(async () => {
  await db.destroy();
});

const tagsOf = async (entityType: 'project' | 'node' | 'artifact', entityId: number) =>
  db
    .selectFrom('tag')
    .select(['tag', 'note'])
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .orderBy('tag', 'asc')
    .execute();

test('tag reaches all three entity types via the identity grammar', async () => {
  const { renderedId } = await attachArtifact(store, { content: 'x', projectId, title: 'x' });
  const set = deriveSet(await store.loadWorkingSet());
  const targets = ['MMR', 'MMR-3', renderedId].map((t) => resolveEntityTokenInSet(set, t));
  await tagEntities(store, targets, ['spec']);

  expect(await tagsOf('project', projectId)).toEqual([{ note: null, tag: 'spec' }]);
  expect(await tagsOf('node', taskId)).toEqual([{ note: null, tag: 'spec' }]);
  expect((await tagsOf('artifact', 1)).map((r) => r.tag)).toEqual(['spec']);
});

test('re-tagging is idempotent; a provided note overwrites', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  await tagEntities(store, [target], ['spec'], 'first');
  await tagEntities(store, [target], ['spec']); // no note → row kept as-is
  expect(await tagsOf('node', taskId)).toEqual([{ note: 'first', tag: 'spec' }]);

  await tagEntities(store, [target], ['spec'], 'second');
  expect(await tagsOf('node', taskId)).toEqual([{ note: 'second', tag: 'spec' }]);
});

test('untag removes only the named tags and reports the count', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  await tagEntities(store, [target], ['spec', 'v2', 'keep']);
  const removed = await untagEntities(store, [target], ['spec', 'v2', 'absent']);
  expect(removed).toBe(2);
  expect((await tagsOf('node', taskId)).map((r) => r.tag)).toEqual(['keep']);
});

test('neither tag nor untag writes the transition log', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  const before = await db.selectFrom('transition_log').selectAll().execute();
  await tagEntities(store, [target], ['spec']);
  await untagEntities(store, [target], ['spec']);
  const after = await db.selectFrom('transition_log').selectAll().execute();
  expect(after.length).toBe(before.length);
});

test('resolveEntityToken rejects unknown project/node and malformed tokens', async () => {
  const set = deriveSet(await store.loadWorkingSet());
  await expectMimirError('not_found', async () => resolveEntityTokenInSet(set, 'ZZZ'));
  await expectMimirError('not_found', async () => resolveEntityTokenInSet(set, 'MMR-99'));
  await expectMimirError('not_found', async () => resolveEntityTokenInSet(set, 'not-an-id'));
});

test('an artifact token resolves by external identity, existence is the seam’s concern (MMR-143)', async () => {
  // Unlike node/project, an artifact token parses to (key, seq) without a DB
  // hit — a vault-backed artifact has no SQLite row, and tags never validate
  // existence (the seam applies to a missing artifact as a silent no-op).
  const set = deriveSet(await store.loadWorkingSet());
  expect(resolveEntityTokenInSet(set, 'MMR-a9')).toEqual({
    entityType: 'artifact',
    key: 'MMR',
    seq: 9,
  });
});

test('create verbs apply creation-time tags', async () => {
  const phase2 = await db
    .selectFrom('node')
    .select('id')
    .where('type', '=', 'phase')
    .executeTakeFirstOrThrow();
  const t = await createTask(store, { parentId: phase2.id, tags: ['spec', 'v2'], title: 'tt' });
  expect((await tagsOf('node', t.id)).map((r) => r.tag)).toEqual(['spec', 'v2']);

  const p = await createProject(store, { key: 'OTH', name: 'o', tags: ['ws'] });
  expect((await tagsOf('project', p.id)).map((r) => r.tag)).toEqual(['ws']);
});
