import { afterEach, expect, test } from 'bun:test';

import type { Server } from 'bun';

import { inertStore } from '../testing/store';
import { createServer } from './server';

/**
 * Where `serve` listens (`[serve] bind`, MMR-433): loopback unless told
 * otherwise, and an address this machine does not carry is refused by name
 * rather than reported as a taken port and hunted past.
 */

let server: Server<undefined> | undefined;
let other: Server<undefined> | undefined;

afterEach(async () => {
  await server?.stop(true);
  await other?.stop(true);
  server = undefined;
  other = undefined;
});

/** Another process's listener on loopback, answering with its own version. */
function holdLoopback(): number {
  other = Bun.serve({
    fetch: () => Response.json({ version: '9.9.9-other' }),
    hostname: '127.0.0.1',
    port: 0,
  });
  return other.port ?? 0;
}

test('serve binds loopback when no hostname is given', () => {
  server = createServer(inertStore(), { port: 0, version: '0.0.0-test' });
  expect(server.hostname).toBe('127.0.0.1');
});

test('serve binds the given address, and a wildcard answers on loopback', async () => {
  server = createServer(inertStore(), { hostname: '0.0.0.0', port: 0, version: '0.0.0-test' });
  expect(server.hostname).toBe('0.0.0.0');
  const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/health`);
  expect(res.status).toBe(200);
});

test('an address not on this machine is refused by name, without a port hunt', () => {
  let caught: unknown;
  try {
    // 192.0.2.0/24 is TEST-NET-1: documentation only, never on an interface.
    server = createServer(inertStore(), { hostname: '192.0.2.55', port: 0, version: '0.0.0-test' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code: 'EADDRNOTAVAIL' });
  expect((caught as Error).message).toContain('192.0.2.55');
});

test('a wildcard bind counts a port held on loopback as taken and hunts past it', async () => {
  const held = holdLoopback();
  server = createServer(inertStore(), { hostname: '0.0.0.0', port: held, version: '0.0.0-test' });
  expect(server.port).not.toBe(held);
  const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/health`);
  expect(await res.json()).toMatchObject({ version: '0.0.0-test' });
});

test('without the hunt, a wildcard bind over a held loopback port fails as taken', () => {
  const held = holdLoopback();
  let caught: unknown;
  try {
    server = createServer(inertStore(), {
      hostname: '0.0.0.0',
      hunt: false,
      port: held,
      version: '0.0.0-test',
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toMatchObject({ code: 'EADDRINUSE' });
});
