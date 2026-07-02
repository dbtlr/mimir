import { afterAll, beforeAll, expect, test } from 'bun:test';

import type { Server } from 'bun';

import type { Db } from '../core/context';
import { createInitiative, createPhase, createProject, createTask } from '../core/create';
import { attachArtifact } from '../core/mutations';
import { createSqliteStore } from '../core/store-sqlite';
import { createTestDb } from '../db/testing';
import { createServer } from './server';

let db: Db;
let server: Server<undefined>;
let base: string;

beforeAll(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(db, { projectId: p.id, title: 'i' });
  const phase = await createPhase(db, { parentId: init.id, title: 'ph' });
  const t = await createTask(db, { parentId: phase.id, title: 't' });
  await attachArtifact(db, {
    content: 'loopback and Caddy',
    linkNodeIds: [t.id],
    projectId: p.id,
    tags: ['kind:spec'],
    title: 'Auth gate design',
  });
  server = createServer(createSqliteStore(db), { hunt: false, port: 0, version: 'test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.stop(true);
  await db.destroy();
});

test('GET /api/artifacts returns the envelope of summaries', async () => {
  const res = await fetch(`${base}/api/artifacts`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total: number; items: { id: string; project: string }[] };
  expect(body.total).toBe(1);
  expect(body.items[0]).toMatchObject({ project: 'MMR', title: 'Auth gate design' });
  expect(body.items[0]?.id).toMatch(/^MMR-a\d+$/);
  expect(body.items[0]).not.toHaveProperty('content');
});

test('q filter is honored over the wire', async () => {
  const hit = (await (await fetch(`${base}/api/artifacts?q=caddy`)).json()) as { total: number };
  expect(hit.total).toBe(1);
  const miss = (await (await fetch(`${base}/api/artifacts?q=nonexistent`)).json()) as {
    total: number;
    items: unknown[];
  };
  expect(miss.total).toBe(0);
  expect(miss.items).toEqual([]);
});

test("a bare-date before still includes the same day's artifacts", async () => {
  // the seeded artifact was created today; a bare-date `before` of today must include it
  const today = new Date().toISOString().slice(0, 10);
  const body = (await (await fetch(`${base}/api/artifacts?before=${today}`)).json()) as {
    total: number;
  };
  expect(body.total).toBe(1);
});

test('invalid limit is a 4xx, not a crash', async () => {
  const res = await fetch(`${base}/api/artifacts?limit=0`);
  expect(res.status).toBeGreaterThanOrEqual(400);
});
