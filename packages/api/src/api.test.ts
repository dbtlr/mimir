import { afterEach, expect, test } from 'bun:test';

import { createInitiative, createProject, createTask } from '@mimir/core';
import { createTestStore } from '@mimir/core/testing';
import type { Server } from 'bun';

import { createApiHandler } from './index';

let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await closeStore?.();
  closeStore = undefined;
});

test('the shared API dispatches project parameters and methods through a real store', async () => {
  const built = await createTestStore();
  closeStore = built.close;
  await createProject(built.store, { key: 'API', name: 'Before' });
  const api = createApiHandler(built.store, { version: 'shared-test' });
  const response = await api(
    new Request('http://localhost/api/projects/API', {
      body: JSON.stringify({ name: 'After' }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: 'API', title: 'After' });
  const detail = await api(new Request('http://localhost/api/projects/API'));
  expect(await detail.json()).toMatchObject({ id: 'API', title: 'After' });
});

test('malformed percent-encoded path parameters still return the JSON resource envelope', async () => {
  const built = await createTestStore();
  closeStore = built.close;
  const api = createApiHandler(built.store, { version: 'shared-test' });
  const response = await api(new Request('http://localhost/api/projects/%ZZ'));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'validation' } });
});

test('the HTTP dispatcher selects nested routes, decodes both parameters, and preserves method fallbacks', async () => {
  const built = await createTestStore();
  closeStore = built.close;
  const project = await createProject(built.store, { key: 'API', name: 'API project' });
  const initiative = await createInitiative(built.store, {
    projectId: project.key,
    title: 'Delivery',
  });
  const task = await createTask(built.store, { parentId: initiative.id, title: 'Shared API' });
  const taskRef = `API-${String(task.seq)}`;
  server = Bun.serve({
    fetch: createApiHandler(built.store, { version: 'shared-test' }),
    hostname: '127.0.0.1',
    port: 0,
  });
  const base = server.url;
  const tag = await fetch(new URL(`/api/nodes/${taskRef}/tags/next%2Fstep%2Bnow`, base), {
    method: 'PUT',
  });
  expect(tag.status).toBe(200);
  expect(await tag.json()).toMatchObject({ tags: [{ tag: 'next/step+now' }] });

  const tree = await fetch(new URL('/api/projects/%41PI/tree', base));
  expect(tree.status).toBe(200);
  expect(await tree.json()).toMatchObject({
    children: [{ id: `API-${String(initiative.seq)}` }],
    id: 'API',
  });

  for (const [path, method] of [
    ['/api', 'GET'],
    ['/api/unknown', 'GET'],
    ['/api/health', 'POST'],
    ['/api/health', 'OPTIONS'],
    ['/api/health/', 'GET'],
    ['/api/projects/API/tree/extra', 'GET'],
  ]) {
    const response = await fetch(new URL(path ?? '', base), { method });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  }
  const health = await fetch(new URL('/api/health', base), { method: 'HEAD' });
  expect(health.status).toBe(200);
  expect(await health.text()).toBe('');
});
