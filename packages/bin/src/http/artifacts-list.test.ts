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
  // Norn's q rides `contains` over title only, case-sensitive (core/store-norn/artifacts.ts) —
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

test.skipIf(!NORN)('a bare-date at-or-before includes the same caller-local day', async () => {
  // The artifact was created today; today's window must contain it, resolved
  // through the caller's own zone rather than UTC's calendar (ADR 0029).
  const zone = 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  const body = (await (
    await fetch(`${base}/api/artifacts?at-or-before=created_at:${today}&tz=${zone}`)
  ).json()) as { total: number };
  expect(body.total).toBe(1);
});

test.skipIf(!NORN)('a bare date with no tz is a validation error', async () => {
  const res = await fetch(`${base}/api/artifacts?on=created_at:2026-07-31`);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string; hint: string; message: string } };
  expect(body.error.code).toBe('validation');
  expect(body.error.message).toContain('no caller timezone');
  expect(body.error.hint).toContain('tz');
});

test.skipIf(!NORN)('an unknown tz is a validation error', async () => {
  const res = await fetch(`${base}/api/artifacts?on=created_at:2026-07-31&tz=Mars/Olympus`);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('unknown timezone');
});

test.skipIf(!NORN)('an impossible artifact date bound is a validation error', async () => {
  const res = await fetch(`${base}/api/artifacts?at-or-after=created_at:2026-02-30&tz=UTC`);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'validation',
      hint: '2026-02 has no such day',
      message: 'invalid date: 2026-02-30',
    },
  });
});

test.skipIf(!NORN)('a malformed before bound is a validation error', async () => {
  const res = await fetch(`${base}/api/artifacts?before=created_at:2026-07-31T99:00:00Z&tz=UTC`);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('validation');
  expect(body.error.message).toBe('invalid date: 2026-07-31T99:00:00Z');
});

test.skipIf(!NORN)('a zone-less timestamp bound is a validation error', async () => {
  const res = await fetch(`${base}/api/artifacts?before=created_at:2026-07-31T10:15:00`);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { hint: string } };
  expect(body.error.hint).toContain('explicit zone');
});

// A date param this API doesn't have is refused, never ignored: a dropped bound
// answers a different question than the one asked (ADR 0029). That covers the
// retired operators AND the camelCase spellings MCP uses, which a caller
// crossing transports reaches for.
test.skipIf(!NORN).each([
  ['/api/artifacts', 'since', 'at-or-after'],
  ['/api/artifacts', 'not-before', 'at-or-after'],
  ['/api/artifacts', 'atOrAfter', 'at-or-after'],
  ['/api/artifacts', 'atOrBefore', 'at-or-before'],
  ['/api/nodes', 'since', 'at-or-after'],
  ['/api/nodes', 'not-after', 'at-or-before'],
  ['/api/nodes', 'atOrAfter', 'at-or-after'],
  ['/api/seeds', 'notBefore', 'at-or-after'],
  ['/api/seeds', 'atOrBefore', 'at-or-before'],
])('%s refuses %s with its replacement', async (route, param, replacement) => {
  const res = await fetch(`${base}${route}?${param}=created_at:2026-07-01&tz=UTC`);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { hint: string; message: string } };
  expect(body.error.message).toBe(`${param} is not a filter`);
  expect(body.error.hint).toContain(`${replacement}=FIELD:VALUE`);
});

// The zone is validated on its own terms, filters or not — a shrug would teach
// the caller their zone had been honored.
test.skipIf(!NORN).each(['/api/artifacts', '/api/nodes', '/api/seeds'])(
  '%s refuses an unknown tz with no date filter',
  async (route) => {
    const res = await fetch(`${base}${route}?tz=Mars/Olympus`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('unknown timezone');
  },
);

// The transitions cursor is not a date filter and keeps its own `since` — the
// date-param guard must not reach it (ADR 0029 leaves the cursor alone).
test.skipIf(!NORN)('the transitions cursor still owns its since param', async () => {
  expect((await fetch(`${base}/api/transitions`)).status).toBe(200);
  const res = await fetch(`${base}/api/transitions?since=0`);
  const body = (await res.json()) as { error: { message: string } };
  expect(body.error.message).toBe('invalid cursor 0');
});

test.skipIf(!NORN)('a numeric-offset bound is compared as its canonical UTC instant', async () => {
  const bound = new Date(Date.now() - 30 * 60 * 1000);
  const local = new Date(bound.getTime() + 2 * 60 * 60 * 1000).toISOString().replace('Z', '+02:00');
  const body = (await (
    await fetch(`${base}/api/artifacts?at-or-after=${encodeURIComponent(`created_at:${local}`)}`)
  ).json()) as { total: number };
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
