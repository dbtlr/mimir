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

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

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
