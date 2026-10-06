import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { Server } from 'bun';

import { acceptedHosts } from '../service/address';
import { inertStore } from '../testing/store';
import { isCrossOriginWrite } from './host';
import { createServer } from './server';

/**
 * The Host guard over the real server (MMR-425): a page whose domain rebinds
 * to 127.0.0.1 is same-origin with the daemon but still sends its own name as
 * Host, so once `[serve] hosts` is set, anything but a loopback name or a
 * listed host is refused before a route runs. Without `hosts` the Host check
 * is off (MMR-432); the cross-origin write check holds either way. The inert
 * store proves refusals never reach the store.
 */

let server: Server<undefined> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

function start(hosts?: readonly string[]): string {
  server = createServer(inertStore(), {
    port: 0,
    version: '0.0.0-test',
    ...(hosts === undefined ? {} : { hosts }),
  });
  return `http://127.0.0.1:${String(server.port)}`;
}

function get(base: string, path: string, host: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { host } });
}

test('a rebound domain is refused on API routes, the console, and the fallback', async () => {
  const base = start([]);
  for (const path of ['/api/health', '/api/nodes', '/api/doctor', '/', '/api/nope']) {
    const res = await get(base, path, 'attacker.example:64647');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_host');
  }
});

test('a rebound domain cannot write or preflight', async () => {
  const base = start([]);
  const write = await fetch(`${base}/api/projects`, {
    body: JSON.stringify({ key: 'EVL', name: 'evil' }),
    headers: { 'content-type': 'application/json', host: 'attacker.example' },
    method: 'POST',
  });
  expect(write.status).toBe(403);
  const preflight = await fetch(`${base}/api/nodes`, {
    headers: { host: 'attacker.example', origin: 'http://localhost:5173' },
    method: 'OPTIONS',
  });
  expect(preflight.status).toBe(403);
});

test('a Host that only starts with a loopback name is refused', async () => {
  const base = start([]);
  for (const host of ['localhost:1@attacker.example', '[::1]attacker.example', 'localhost:x']) {
    expect((await get(base, '/api/health', host)).status).toBe(403);
  }
});

test('each refused name is logged once, and the log stops growing past a cap', async () => {
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((line: string) => {
    lines.push(line);
  });
  try {
    const base = start([]);
    await get(base, '/api/health', 'attacker.example:1');
    await get(base, '/api/health', 'ATTACKER.example:2');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"attacker.example"');
    for (let i = 0; i < 100; i++) {
      await get(base, '/api/health', `n${String(i)}.attacker.example`);
    }
    expect(lines.length).toBeLessThan(100);
    expect(lines.at(-1)).toContain('further refused hosts are not logged');
  } finally {
    error.mockRestore();
  }
});

test('loopback names reach the daemon on any port', async () => {
  const base = start([]);
  for (const host of ['127.0.0.1:64647', 'localhost:5173', 'LOCALHOST', '[::1]:64647']) {
    const res = await get(base, '/api/health', host);
    expect(res.status).toBe(200);
  }
});

test('without [serve] hosts, any Host is answered (MMR-432)', async () => {
  const base = start();
  for (const host of ['box', 'box.tailnet.ts.net', '192.168.1.10:64647', 'attacker.example']) {
    expect((await get(base, '/api/health', host)).status).toBe(200);
  }
});

test('without [serve] hosts, a same-origin write by any name lands and a cross-origin one does not', async () => {
  // An unrouted POST shows the guard's verdict: admitted → 404, refused → 403.
  const base = start();
  const post = (host: string, origin: string) =>
    fetch(`${base}/api/nope`, { headers: { host, origin }, method: 'POST' });
  expect((await post('192.168.1.10:64647', 'http://192.168.1.10:64647')).status).toBe(404);
  expect((await post('box.tailnet.ts.net', 'https://box.tailnet.ts.net')).status).toBe(404);
  const cross = await post('box.tailnet.ts.net', 'https://evil.example');
  expect(cross.status).toBe(403);
  expect(((await cross.json()) as { error: { code: string } }).error.code).toBe('forbidden_origin');
});

test('an empty [serve] hosts answers the loopback names only', async () => {
  const base = start([]);
  expect((await get(base, '/api/health', 'localhost:64647')).status).toBe(200);
  expect((await get(base, '/api/health', 'box.tailnet.ts.net')).status).toBe(403);
});

test('a configured proxy host is accepted whatever its case or port', async () => {
  const base = start(['Mimir.Example.Test']);
  for (const host of ['mimir.example.test', 'MIMIR.EXAMPLE.TEST:443']) {
    const res = await get(base, '/api/health', host);
    expect(res.status).toBe(200);
  }
  expect((await get(base, '/api/health', 'other.example.test')).status).toBe(403);
});

test("with [serve] hosts set, the configured url's host is answered too (MMR-433)", async () => {
  const base = start(acceptedHosts({ hosts: [], url: 'https://box.tailnet.ts.net' }));
  expect((await get(base, '/api/health', 'box.tailnet.ts.net')).status).toBe(200);
  expect((await get(base, '/api/health', 'other.tailnet.ts.net')).status).toBe(403);
});

test('a configured host does not admit its subdomains or look-alikes', async () => {
  const base = start(['mimir.example.test']);
  for (const host of [
    'evil.mimir.example.test',
    'mimir.example.test.evil',
    'xmimir.example.test',
  ]) {
    expect((await get(base, '/api/health', host)).status).toBe(403);
  }
});

test('a write from another origin is refused before a route runs (MMR-426)', async () => {
  // No CORS keeps another page from reading, but a browser still sends a
  // "simple" POST cross-origin without a preflight. The inert store proves
  // the refusal comes before any route touches the board.
  const base = start();
  const self = new URL(base).host;
  const writes: { method: string; path: string; body?: string }[] = [
    { body: JSON.stringify({ key: 'EVL', name: 'evil' }), method: 'POST', path: '/api/projects' },
    { method: 'POST', path: '/api/nodes/EVL-1/done' },
    { body: '{}', method: 'PATCH', path: '/api/nodes/EVL-1' },
    { method: 'DELETE', path: '/api/nodes/EVL-1' },
  ];
  const origins = [
    'http://localhost:3000',
    `http://localhost:${new URL(base).port}`,
    'https://evil.example',
    'null',
  ];
  for (const { body, method, path } of writes) {
    for (const origin of origins) {
      const res = await fetch(`${base}${path}`, {
        body,
        headers: { 'content-type': 'text/plain', host: self, origin },
        method,
      });
      expect(res.status).toBe(403);
      const refusal = (await res.json()) as { error: { code: string } };
      expect(refusal.error.code).toBe('forbidden_origin');
    }
  }
});

test('a write through a proxy host lands when the proxy keeps Host (MMR-426)', async () => {
  // Behind Caddy the Origin is https with no port, and Host is the proxy name.
  // An unrouted POST shows the guard's verdict: admitted → 404, refused → 403.
  const base = start(['mimir.example']);
  const post = (host: string) =>
    fetch(`${base}/api/nope`, {
      headers: { host, origin: 'https://mimir.example' },
      method: 'POST',
    });
  expect((await post('mimir.example')).status).toBe(404);
  expect((await post('mimir.example:443')).status).toBe(404);
  // A proxy that rewrites Host to the upstream address loses its writes.
  const rewritten = await post(new URL(base).host);
  expect(rewritten.status).toBe(403);
  expect(((await rewritten.json()) as { error: { code: string } }).error.code).toBe(
    'forbidden_origin',
  );
});

const write = (headers: Record<string, string>, method = 'POST') =>
  isCrossOriginWrite(new Request('http://127.0.0.1/api/projects', { headers, method }));

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
