import { afterEach, expect, test } from 'bun:test';

import type { Server } from 'bun';

import type { Db } from '../core';
import { createTestDb } from '../db/testing';
import { PORT_HUNT_SPAN, createServer } from './server';

/**
 * The port hunt (MMR-53): a taken port walks upward to the next free one; the
 * hunt is bounded, and exhaustion throws the same bind-error class so the CLI
 * renders it as a normal failure.
 */

let squatters: Server<undefined>[] = [];
let db: Db | undefined;

afterEach(async () => {
  for (const s of squatters) {
    await s.stop(true);
  }
  squatters = [];
  await db?.destroy();
  db = undefined;
});

/**
 * Hold a port for the test's duration. A port someone else already holds is
 * just as occupied, so an outside EADDRINUSE counts as success.
 */
function occupy(port: number): Server<undefined> | undefined {
  try {
    const s = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('squat') });
    squatters.push(s);
    return s;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
      return undefined;
    }
    throw err;
  }
}

/** The bound TCP port; Bun types it optional (unix sockets have none). */
function portOf(s: Server<undefined>): number {
  if (s.port === undefined) throw new Error('server has no port');
  return s.port;
}

/** An ephemeral squatter low enough that the whole hunt range stays valid. */
function squatWithHeadroom(): Server<undefined> {
  for (;;) {
    const s = occupy(0);
    if (s !== undefined && portOf(s) + PORT_HUNT_SPAN <= 65535) {
      return s;
    }
  }
}

test('a free requested port binds exactly', async () => {
  db = await createTestDb();
  const probe = occupy(0);
  if (probe === undefined) throw new Error('port 0 must bind');
  const port = portOf(probe);
  await probe.stop(true);
  squatters.splice(squatters.indexOf(probe), 1);

  const server = createServer(db, { port, version: '0.0.0-test' });
  squatters.push(server);
  expect(server.port).toBe(port);
});

test('a taken port hunts upward to the next free one', async () => {
  db = await createTestDb();
  const taken = portOf(squatWithHeadroom());

  const server = createServer(db, { port: taken, version: '0.0.0-test' });
  squatters.push(server);
  expect(portOf(server)).toBeGreaterThan(taken);
  expect(portOf(server)).toBeLessThanOrEqual(taken + PORT_HUNT_SPAN);

  const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/projects`);
  expect(res.status).toBe(200);
});

test('exhausting the hunt span fails with EADDRINUSE naming the range', async () => {
  db = await createTestDb();
  const base = portOf(squatWithHeadroom());
  for (let p = base + 1; p <= base + PORT_HUNT_SPAN; p++) {
    occupy(p);
  }

  let thrown: unknown;
  try {
    createServer(db, { port: base, version: '0.0.0-test' });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code?: string }).code).toBe('EADDRINUSE');
  expect((thrown as Error).message).toContain(String(base));
  expect((thrown as Error).message).toContain(String(base + PORT_HUNT_SPAN));
});

test('hunt: false fails loudly on a taken port instead of walking', async () => {
  db = await createTestDb();
  const taken = portOf(squatWithHeadroom());
  let thrown: unknown;
  try {
    const server = createServer(db, { port: taken, version: '0.0.0-test', hunt: false });
    squatters.push(server);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code?: string }).code).toBe('EADDRINUSE');
});
