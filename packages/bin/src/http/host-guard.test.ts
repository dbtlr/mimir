import { afterEach, expect, test } from 'bun:test';

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
