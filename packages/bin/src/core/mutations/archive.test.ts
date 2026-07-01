import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestDb } from '../../db/testing';
import type { Db } from '../context';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { expectMimirError } from '../testing';
import { archiveProject, unarchiveProject } from './archive';
import { annotate, attachArtifact, updateNode, updateProject } from './data';
import { startTask } from './lifecycle';
import { moveNode } from './structure';
import { tagEntities } from './tags';

/**
 * Project archive (ADR 0015): a reversible, reason-bearing project axis that
 * freezes the whole subtree. These cover the write-lock choke point (no
 * mutation under an archived project), the logged transition, reversibility,
 * idempotency, and isolation from sibling projects.
 */

let db: Db;
let projectId: number;
let phaseId: number;
let taskId: number;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: 'MMR', name: 'm' });
  projectId = p.id;
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
  const task = await createTask(db, { parentId: phase.id, title: 't' });
  taskId = task.id;
});
afterEach(async () => {
  await db.destroy();
});

test('archive sets archived_at and logs a project-keyed transition with the reason', async () => {
  const project = await archiveProject(db, projectId, 'superseded by SAGA2');
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
  await archiveProject(db, projectId);

  // node-targeting verbs (guarded via requireNode/requireTask)
  await expectMimirError('conflict', () => startTask(db, taskId));
  await expectMimirError('conflict', () => updateNode(db, taskId, { priority: 'p1' }));
  await expectMimirError('conflict', () => annotate(db, taskId, 'note'));
  await expectMimirError('conflict', () => moveNode(db, taskId, phaseId));

  // create under the archived project (guarded via assertProjectActive)
  await expectMimirError('conflict', () => createTask(db, { parentId: phaseId, title: 'x' }));
  await expectMimirError('conflict', () => createInitiative(db, { projectId, title: 'x' }));

  // project-level + attach + tag paths
  await expectMimirError('conflict', () => updateProject(db, projectId, { name: 'new' }));
  await expectMimirError('conflict', () =>
    attachArtifact(db, { content: 'c', projectId, title: 'a' }),
  );
  await expectMimirError('conflict', () =>
    tagEntities(db, [{ entityId: taskId, entityType: 'node' }], ['tag']),
  );
  await expectMimirError('conflict', () =>
    tagEntities(db, [{ entityId: projectId, entityType: 'project' }], ['tag']),
  );
});

test('unarchive clears archived_at, logs the reverse transition, and re-enables mutation', async () => {
  await archiveProject(db, projectId);
  const project = await unarchiveProject(db, projectId);
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
  const task = await startTask(db, taskId);
  expect(task.lifecycle).toBe('in_progress');
});

test('archive/unarchive idempotency is a conflict, not a silent no-op', async () => {
  await archiveProject(db, projectId);
  await expectMimirError('conflict', () => archiveProject(db, projectId));

  await unarchiveProject(db, projectId);
  await expectMimirError('conflict', () => unarchiveProject(db, projectId));
});

test('archiving one project leaves a sibling project fully mutable', async () => {
  const other = await createProject(db, { key: 'OTH', name: 'o' });
  const otherInit = await createInitiative(db, { projectId: other.id, title: 'i' });
  const otherPhase = await createPhase(db, { parentId: otherInit.id, title: 'ph' });
  const otherTask = await createTask(db, { parentId: otherPhase.id, title: 't' });

  await archiveProject(db, projectId);

  // the sibling is unaffected
  const started = await startTask(db, otherTask.id);
  expect(started.lifecycle).toBe('in_progress');
});
