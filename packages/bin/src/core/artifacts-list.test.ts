import { afterEach, beforeEach, expect, test } from 'bun:test';

import { sql } from 'kysely';

import { createTestDb } from '../db/testing';
import { listArtifacts } from './artifacts-list';
import type { Db } from './context';
import { createInitiative, createPhase, createProject, createTask } from './create';
import { attachArtifact } from './mutations';

let db: Db;

async function phaseFor(projectId: number): Promise<number> {
  const init = await createInitiative(db, { projectId, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  return phase.id;
}

beforeEach(async () => {
  db = await createTestDb();
  const mmr = await createProject(db, { key: 'MMR', name: 'Mimir' });
  const nova = await createProject(db, { key: 'NOVA', name: 'Nova' });
  const t1 = await createTask(db, { parentId: await phaseFor(mmr.id), title: 't' });
  const t2 = await createTask(db, { parentId: await phaseFor(nova.id), title: 't' });
  await attachArtifact(db, {
    projectId: mmr.id,
    title: 'Auth gate design',
    content: 'we argued about the loopback path and Caddy',
    linkNodeIds: [t1.id],
    tags: ['kind:spec'],
  });
  await attachArtifact(db, {
    projectId: mmr.id,
    title: 'Session log 2026-06-14',
    content: 'shipped the output contract',
    linkNodeIds: [t1.id],
    tags: ['kind:session-log'],
  });
  await attachArtifact(db, {
    projectId: nova.id,
    title: 'Nova kickoff',
    content: 'auth shows up here too',
    linkNodeIds: [t2.id],
    tags: ['kind:spec'],
  });
});

afterEach(async () => {
  await db.destroy();
});

test('lists every artifact across projects, newest-first', async () => {
  const { total, items } = await listArtifacts(db);
  expect(total).toBe(3);
  expect(items.map((a) => a.title)).toEqual([
    'Nova kickoff',
    'Session log 2026-06-14',
    'Auth gate design',
  ]);
  expect(items[0]).toMatchObject({ project: 'NOVA', tags: ['kind:spec'] });
  expect(items[0]?.id).toMatch(/^NOVA-a\d+$/);
  expect(items[0]).not.toHaveProperty('content');
});

test('project filter scopes to one project', async () => {
  const { items } = await listArtifacts(db, { project: 'MMR' });
  expect(items.every((a) => a.project === 'MMR')).toBe(true);
  expect(items).toHaveLength(2);
});

test('tag filter matches artifacts carrying the tag', async () => {
  const { items } = await listArtifacts(db, { tag: 'kind:spec' });
  expect(items.map((a) => a.title).toSorted()).toEqual(['Auth gate design', 'Nova kickoff']);
});

test('q matches title OR content, case-insensitive, across projects', async () => {
  const { items } = await listArtifacts(db, { q: 'AUTH' });
  expect(items.map((a) => a.title).toSorted()).toEqual(['Auth gate design', 'Nova kickoff']);
});

test('filters compose with AND', async () => {
  const { items } = await listArtifacts(db, { q: 'auth', project: 'MMR' });
  expect(items.map((a) => a.title)).toEqual(['Auth gate design']);
});

test('since/before bound created_at', async () => {
  await sql`UPDATE artifact SET created_at = '2020-01-01T00:00:00.000Z' WHERE seq = 1 AND project_id = (SELECT id FROM project WHERE key = 'MMR')`.execute(
    db,
  );
  const recent = await listArtifacts(db, { since: '2021-01-01T00:00:00.000Z' });
  expect(recent.items.some((a) => a.title === 'Auth gate design')).toBe(false);
  const old = await listArtifacts(db, { before: '2021-01-01T00:00:00.000Z' });
  expect(old.items.map((a) => a.title)).toEqual(['Auth gate design']);
});
