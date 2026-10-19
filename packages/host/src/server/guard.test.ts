import { describe, expect, spyOn, test } from 'bun:test';

import { acceptedHosts } from '@mimir/core';

import { guardEveryRoute, hostGuard, isCrossOriginWrite } from './guard';

/*
 * The host guard runs before any route dispatches, server functions included,
 * so a refused request never reaches Start (whose own CSRF middleware, in
 * src/start.ts, would check a server function again). A Host that is not
 * answered, or a write from another origin, is refused before a route runs;
 * without MIMIR_HOSTS the Host check is off (MMR-432) and the cross-origin
 * write check holds either way.
 */

const ORIGIN = 'http://127.0.0.1:64647';

/** The guard over a stub dispatcher that records the paths it was asked to serve. */
function guarded(hosts?: readonly string[]) {
  const reached: string[] = [];
  const fetch = guardEveryRoute(
    async (request: Request) => {
      reached.push(new URL(request.url).pathname);
      return new Response('dispatched');
    },
    Promise.resolve(hostGuard(hosts)),
  );
  return { fetch, reached };
}

function get(fetch: ReturnType<typeof guarded>['fetch'], path: string, host: string) {
  return fetch(new Request(`${ORIGIN}${path}`, { headers: { host } }));
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
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
  expect(await codeOf(response)).toBe('forbidden_origin');
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

test('a rebound domain is refused on every route', async () => {
  const { fetch, reached } = guarded([]);
  for (const path of ['/health', '/trpc/projects', '/_serverFn/abc123', '/', '/api/projects']) {
    const res = await get(fetch, path, 'attacker.example:64647');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('forbidden_host');
  }
  expect(reached).toEqual([]);
});

test('a rebound domain cannot write or preflight', async () => {
  const { fetch, reached } = guarded([]);
  const write = await fetch(
    new Request(`${ORIGIN}/trpc/create`, {
      body: JSON.stringify({ key: 'EVL', name: 'evil' }),
      headers: { 'content-type': 'application/json', host: 'attacker.example' },
      method: 'POST',
    }),
  );
  expect(write.status).toBe(403);
  const preflight = await fetch(
    new Request(`${ORIGIN}/trpc/create`, {
      headers: { host: 'attacker.example', origin: 'http://localhost:5173' },
      method: 'OPTIONS',
    }),
  );
  expect(preflight.status).toBe(403);
  expect(reached).toEqual([]);
});

test('a Host that only starts with a loopback name is refused', async () => {
  const { fetch } = guarded([]);
  for (const host of ['localhost:1@attacker.example', '[::1]attacker.example', 'localhost:x']) {
    expect((await get(fetch, '/health', host)).status).toBe(403);
  }
});

test('each refused name is logged once, and the log stops growing past a cap', async () => {
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((line: string) => {
    lines.push(line);
  });
  try {
    const { fetch } = guarded([]);
    await get(fetch, '/health', 'attacker.example:1');
    await get(fetch, '/health', 'ATTACKER.example:2');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"attacker.example"');
    for (let i = 0; i < 100; i++) {
      await get(fetch, '/health', `n${String(i)}.attacker.example`);
    }
    expect(lines.length).toBeLessThan(100);
    expect(lines.at(-1)).toContain('further refused hosts are not logged');
  } finally {
    error.mockRestore();
  }
});

test('loopback names reach the host on any port', async () => {
  const { fetch } = guarded([]);
  for (const host of ['127.0.0.1:64647', 'localhost:5173', 'LOCALHOST', '[::1]:64647']) {
    expect((await get(fetch, '/health', host)).status).toBe(200);
  }
});

test('without MIMIR_HOSTS, any Host is answered (MMR-432)', async () => {
  const { fetch } = guarded();
  for (const host of ['box', 'box.tailnet.ts.net', '192.168.1.10:64647', 'attacker.example']) {
    expect((await get(fetch, '/health', host)).status).toBe(200);
  }
});

test('without MIMIR_HOSTS, a same-origin write by any name lands and a cross-origin one does not', async () => {
  const { fetch } = guarded();
  const post = (host: string, origin: string) =>
    fetch(new Request(`${ORIGIN}/trpc/create`, { headers: { host, origin }, method: 'POST' }));
  expect((await post('192.168.1.10:64647', 'http://192.168.1.10:64647')).status).toBe(200);
  expect((await post('box.tailnet.ts.net', 'https://box.tailnet.ts.net')).status).toBe(200);
  const cross = await post('box.tailnet.ts.net', 'https://evil.example');
  expect(cross.status).toBe(403);
  expect(await codeOf(cross)).toBe('forbidden_origin');
});

test('an empty MIMIR_HOSTS answers the loopback names only', async () => {
  const { fetch } = guarded([]);
  expect((await get(fetch, '/health', 'localhost:64647')).status).toBe(200);
  expect((await get(fetch, '/health', 'box.tailnet.ts.net')).status).toBe(403);
});

test('a configured proxy host is accepted whatever its case or port', async () => {
  const { fetch } = guarded(['Mimir.Example.Test']);
  for (const host of ['mimir.example.test', 'MIMIR.EXAMPLE.TEST:443']) {
    expect((await get(fetch, '/health', host)).status).toBe(200);
  }
  expect((await get(fetch, '/health', 'other.example.test')).status).toBe(403);
});

test("with MIMIR_HOSTS set, the configured url's host is answered too (MMR-433)", async () => {
  const { fetch } = guarded(acceptedHosts({ hosts: [], url: 'https://box.tailnet.ts.net' }));
  expect((await get(fetch, '/health', 'box.tailnet.ts.net')).status).toBe(200);
  expect((await get(fetch, '/health', 'other.tailnet.ts.net')).status).toBe(403);
});

test('a configured host does not admit its subdomains or look-alikes', async () => {
  const { fetch } = guarded(['mimir.example.test']);
  for (const host of [
    'evil.mimir.example.test',
    'mimir.example.test.evil',
    'xmimir.example.test',
  ]) {
    expect((await get(fetch, '/health', host)).status).toBe(403);
  }
});

test('a write from another origin is refused before a route runs (MMR-426)', async () => {
  // The host grants no CORS, which keeps another page from reading, but a
  // browser still sends a "simple" POST cross-origin without a preflight.
  const { fetch, reached } = guarded();
  const writes: { method: string; path: string; body?: string }[] = [
    { body: JSON.stringify({ key: 'EVL', name: 'evil' }), method: 'POST', path: '/trpc/create' },
    { method: 'POST', path: '/trpc/done' },
    { body: '{}', method: 'PATCH', path: '/trpc/updateNode' },
    { method: 'DELETE', path: '/trpc/anything' },
  ];
  const origins = [
    'http://localhost:3000',
    `http://localhost:64647`,
    'https://evil.example',
    'null',
  ];
  for (const { body, method, path } of writes) {
    for (const origin of origins) {
      const res = await fetch(
        new Request(`${ORIGIN}${path}`, {
          body,
          headers: { 'content-type': 'text/plain', host: '127.0.0.1:64647', origin },
          method,
        }),
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('forbidden_origin');
    }
  }
  expect(reached).toEqual([]);
});

test('a write through a proxy host lands when the proxy keeps Host (MMR-426)', async () => {
  // Behind Caddy the Origin is https with no port, and Host is the proxy name.
  const { fetch } = guarded(['mimir.example']);
  const post = (host: string) =>
    fetch(
      new Request(`${ORIGIN}/trpc/create`, {
        headers: { host, origin: 'https://mimir.example' },
        method: 'POST',
      }),
    );
  expect((await post('mimir.example')).status).toBe(200);
  expect((await post('mimir.example:443')).status).toBe(200);
  // A proxy that rewrites Host to the upstream address loses its writes.
  const rewritten = await post('127.0.0.1:64647');
  expect(rewritten.status).toBe(403);
  expect(await codeOf(rewritten)).toBe('forbidden_origin');
});

const write = (headers: Record<string, string>, method = 'POST') =>
  isCrossOriginWrite(new Request('http://127.0.0.1/trpc/create', { headers, method }));

describe('isCrossOriginWrite', () => {
  test('an Origin matching Host is same-origin, default ports and case included', () => {
    expect(write({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(false);
    expect(write({ host: 'Mimir.Example:443', origin: 'https://mimir.example' })).toBe(false);
    expect(write({ host: 'localhost:80', origin: 'http://localhost' })).toBe(false);
    expect(write({ host: '[::1]:8080', origin: 'http://[0:0:0:0:0:0:0:1]:8080' })).toBe(false);
  });

  test('a differing name, port, or an opaque Origin is cross-origin', () => {
    expect(write({ host: 'localhost:64647', origin: 'http://localhost:3000' })).toBe(true);
    expect(write({ host: '127.0.0.1:64647', origin: 'http://localhost:64647' })).toBe(true);
    expect(write({ host: 'localhost:64647', origin: 'null' })).toBe(true);
    expect(write({ host: 'localhost:443', origin: 'http://localhost' })).toBe(true);
  });

  test('Sec-Fetch-Site other than same-origin or none marks a write cross-origin', () => {
    expect(write({ host: 'localhost:64647', 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(write({ host: 'localhost:64647', 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(write({ host: 'localhost:64647', 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(write({ host: 'localhost:64647', 'sec-fetch-site': 'none' })).toBe(false);
  });

  test('reads and Origin-less clients are never cross-origin writes', () => {
    expect(write({ host: 'localhost:64647', origin: 'https://evil.example' }, 'GET')).toBe(false);
    expect(write({ host: 'localhost:64647', origin: 'https://evil.example' }, 'HEAD')).toBe(false);
    expect(write({ host: 'localhost:64647' })).toBe(false);
  });
});
