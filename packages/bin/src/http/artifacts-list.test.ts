import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Server } from 'bun';

import { createInitiative, createPhase, createProject, createTask } from '../core/create';
import { attachArtifact } from '../core/mutations';
import type { Store } from '../core/store';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createServer } from './server';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let server: Server<undefined>;
let base: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  const phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const taskId = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  await attachArtifact(store, {
    content: 'loopback and Caddy',
    linkNodeIds: [taskId],
    projectId,
    tags: ['kind:spec'],
    title: 'Auth gate design',
  });
  server = createServer(store, { hunt: false, port: 0, version: 'test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
  await closeStore();
});

test.skipIf(!NORN)('GET /api/artifacts returns the envelope of summaries', async () => {
  const res = await fetch(`${base}/api/artifacts`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total: number; items: { id: string; project: string }[] };
  expect(body.total).toBe(1);
  expect(body.items[0]).toMatchObject({ project: 'MMR', title: 'Auth gate design' });
  expect(body.items[0]?.id).toMatch(/^MMR-a\d+$/);
  expect(body.items[0]).not.toHaveProperty('content');
});

test.skipIf(!NORN)('q filter is honored over the wire', async () => {
  // Norn's q rides `contains` over title only, case-sensitive (core/artifacts/norn.ts) —
  // the vault backend searches title only, case-sensitive (a documented delta from the retired backend's title+content search).
  const hit = (await (await fetch(`${base}/api/artifacts?q=gate`)).json()) as { total: number };
  expect(hit.total).toBe(1);
  const miss = (await (await fetch(`${base}/api/artifacts?q=nonexistent`)).json()) as {
    total: number;
    items: unknown[];
  };
  expect(miss.total).toBe(0);
  expect(miss.items).toEqual([]);
});

test.skipIf(!NORN)("a bare-date before still includes the same day's artifacts", async () => {
  // the seeded artifact was created today; a bare-date `before` of today must include it
  const today = new Date().toISOString().slice(0, 10);
  const body = (await (await fetch(`${base}/api/artifacts?before=${today}`)).json()) as {
    total: number;
  };
  expect(body.total).toBe(1);
});

test.skipIf(!NORN)('invalid limit is a 4xx, not a crash', async () => {
  const res = await fetch(`${base}/api/artifacts?limit=0`);
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test.skipIf(!NORN)('offset pages the window over the wire; total stays pre-window', async () => {
  const body = (await (await fetch(`${base}/api/artifacts?offset=1`)).json()) as {
    total: number;
    items: unknown[];
  };
  expect(body.total).toBe(1);
  expect(body.items).toEqual([]);
});

test.skipIf(!NORN)('invalid offset is a 4xx, not a crash', async () => {
  const res = await fetch(`${base}/api/artifacts?offset=-1`);
  expect(res.status).toBeGreaterThanOrEqual(400);
});
