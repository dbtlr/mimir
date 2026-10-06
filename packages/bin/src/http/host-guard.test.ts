import { afterEach, expect, spyOn, test } from 'bun:test';

import type { Server } from 'bun';

import { inertStore } from '../testing/store';
import { createServer } from './server';

/**
 * The Host guard over the real server (MMR-425): a page whose domain rebinds
 * to 127.0.0.1 is same-origin with the daemon but still sends its own name as
 * Host, so anything but a loopback name or a configured proxy host is refused
 * before a route runs. The inert store proves refusals never reach the store.
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
  const base = start();
  for (const path of ['/api/health', '/api/nodes', '/api/doctor', '/', '/api/nope']) {
    const res = await get(base, path, 'attacker.example:64647');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_host');
  }
});

test('a rebound domain cannot write or preflight', async () => {
  const base = start();
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
  const base = start();
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
    const base = start();
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
  const base = start();
  for (const host of ['127.0.0.1:64647', 'localhost:5173', 'LOCALHOST', '[::1]:64647']) {
    const res = await get(base, '/api/health', host);
    expect(res.status).toBe(200);
  }
});

test('a configured proxy host is accepted whatever its case or port', async () => {
  const base = start(['Mimir.Example.Test']);
  for (const host of ['mimir.example.test', 'MIMIR.EXAMPLE.TEST:443']) {
    const res = await get(base, '/api/health', host);
    expect(res.status).toBe(200);
  }
  expect((await get(base, '/api/health', 'other.example.test')).status).toBe(403);
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
