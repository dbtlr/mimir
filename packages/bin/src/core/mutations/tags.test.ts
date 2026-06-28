import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { resolveEntityToken } from '../lookup';
import { expectMimirError } from '../testing';
import { attachArtifact } from './data';
import { tagEntities, untagEntities } from './tags';

let db: Db;
let projectId: number;
let taskId: number;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(db, { projectId, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  const task = await createTask(db, { parentId: phase.id, title: 't' });
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
  const { renderedId } = await attachArtifact(db, { projectId, title: 'x', content: 'x' });
  const targets = await Promise.all(
    ['MMR', 'MMR-3', renderedId].map((t) => resolveEntityToken(db, t)),
  );
  await tagEntities(db, targets, ['spec']);

  expect(await tagsOf('project', projectId)).toEqual([{ tag: 'spec', note: null }]);
  expect(await tagsOf('node', taskId)).toEqual([{ tag: 'spec', note: null }]);
  expect((await tagsOf('artifact', 1)).map((r) => r.tag)).toEqual(['spec']);
});

test('re-tagging is idempotent; a provided note overwrites', async () => {
  const target = await resolveEntityToken(db, 'MMR-3');
  await tagEntities(db, [target], ['spec'], 'first');
  await tagEntities(db, [target], ['spec']); // no note → row kept as-is
  expect(await tagsOf('node', taskId)).toEqual([{ tag: 'spec', note: 'first' }]);

  await tagEntities(db, [target], ['spec'], 'second');
  expect(await tagsOf('node', taskId)).toEqual([{ tag: 'spec', note: 'second' }]);
});

test('untag removes only the named tags and reports the count', async () => {
  const target = await resolveEntityToken(db, 'MMR-3');
  await tagEntities(db, [target], ['spec', 'v2', 'keep']);
  const removed = await untagEntities(db, [target], ['spec', 'v2', 'absent']);
  expect(removed).toBe(2);
  expect((await tagsOf('node', taskId)).map((r) => r.tag)).toEqual(['keep']);
});

test('neither tag nor untag writes the transition log', async () => {
  const target = await resolveEntityToken(db, 'MMR-3');
  const before = await db.selectFrom('transition_log').selectAll().execute();
  await tagEntities(db, [target], ['spec']);
  await untagEntities(db, [target], ['spec']);
  const after = await db.selectFrom('transition_log').selectAll().execute();
  expect(after.length).toBe(before.length);
});

test('resolveEntityToken rejects unknown and malformed tokens', async () => {
  await expectMimirError('not_found', () => resolveEntityToken(db, 'ZZZ'));
  await expectMimirError('not_found', () => resolveEntityToken(db, 'MMR-99'));
  await expectMimirError('not_found', () => resolveEntityToken(db, 'MMR-a9'));
  await expectMimirError('not_found', () => resolveEntityToken(db, 'not-an-id'));
});

test('create verbs apply creation-time tags', async () => {
  const phase2 = await db
    .selectFrom('node')
    .select('id')
    .where('type', '=', 'phase')
    .executeTakeFirstOrThrow();
  const t = await createTask(db, { parentId: phase2.id, title: 'tt', tags: ['spec', 'v2'] });
  expect((await tagsOf('node', t.id)).map((r) => r.tag)).toEqual(['spec', 'v2']);

  const p = await createProject(db, { key: 'OTH', name: 'o', tags: ['ws'] });
  expect((await tagsOf('project', p.id)).map((r) => r.tag)).toEqual(['ws']);
});
