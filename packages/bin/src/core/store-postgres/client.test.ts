import { expect, test } from 'bun:test';

import type { PoolConfig } from 'pg';
import { Pool } from 'pg';

import { openPostgres } from './client';

/** Open a handle over a pool the caller keeps hold of, and never connects. */
function opened(): {
  config: PoolConfig;
  logged: string[];
  pool: Pool;
  close: () => Promise<void>;
} {
  const logged: string[] = [];
  let seen: PoolConfig | undefined;
  let pool: Pool | undefined;
  const handle = openPostgres('postgres://mimir:mimir@127.0.0.1:1/mimir', {
    createPool: (config) => {
      seen = config;
      pool = new Pool(config);
      return pool;
    },
    log: (line) => logged.push(line),
  });
  if (seen === undefined || pool === undefined) {
    throw new Error('openPostgres did not build a pool');
  }
  return { close: () => handle.close(), config: seen, logged, pool };
}

test('the pool bounds how long a connection request waits', async () => {
  // Pool exhaustion and an unreachable server both present as "no connection
  // available". Without a timeout the caller waits for one indefinitely, so a
  // `mimir serve` that ran out of connections would hang rather than refuse.
  const handle = opened();
  try {
    expect(handle.config.connectionTimeoutMillis).toBe(5000);
  } finally {
    await handle.close();
  }
});

test('an idle-client fault is logged, not thrown at the process', async () => {
  // `pg` emits `error` on the POOL when an idle connection dies (a server
  // restart, an idle-session timeout, a dropped network). An EventEmitter with
  // no `error` listener rethrows, which would take down `mimir serve` or an MCP
  // session over a fault the next query simply retries past.
  const handle = opened();
  try {
    expect(handle.pool.listenerCount('error')).toBe(1);
    handle.pool.emit('error', new Error('idle client died'));
    expect(handle.logged).toEqual(['the postgres store lost an idle connection: idle client died']);
  } finally {
    await handle.close();
  }
});
