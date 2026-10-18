import { expect, test } from 'bun:test';

import { hostGuard } from '@mimir/api';

import { guardEveryRoute } from './guard';

/*
 * The host guard runs before any route dispatches, server functions included,
 * so a cross-origin server-function write never reaches Start (whose own CSRF
 * middleware, in src/start.ts, would check it again).
 */

const ORIGIN = 'http://127.0.0.1:64647';

function guarded() {
  const reached: string[] = [];
  const fetch = guardEveryRoute(
    async (request: Request) => {
      reached.push(new URL(request.url).pathname);
      return new Response('dispatched');
    },
    Promise.resolve(hostGuard(undefined)),
  );
  return { fetch, reached };
}

test('a cross-origin server-function write is refused before Start dispatches it', async () => {
  const { fetch, reached } = guarded();
  const response = await fetch(
    new Request(`${ORIGIN}/_serverFn/abc123`, {
      body: '{}',
      headers: { host: '127.0.0.1:64647', origin: 'https://elsewhere.example' },
      method: 'POST',
    }),
  );
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'forbidden_origin',
  );
  expect(reached).toEqual([]);
});

test('a same-origin server-function write reaches Start', async () => {
  const { fetch, reached } = guarded();
  const response = await fetch(
    new Request(`${ORIGIN}/_serverFn/abc123`, {
      body: '{}',
      headers: { host: '127.0.0.1:64647', origin: ORIGIN },
      method: 'POST',
    }),
  );
  expect(await response.text()).toBe('dispatched');
  expect(reached).toEqual(['/_serverFn/abc123']);
});
