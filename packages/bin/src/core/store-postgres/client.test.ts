import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mimir-pool-test-')));
  const paths = {
    cache: join(root, 'cache', 'mimir'),
    config: join(root, 'config', 'mimir'),
    data: join(root, 'data', 'mimir'),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true });
  }
  const url = `postgres://mimir_sandbox:${'c'.repeat(64)}@127.0.0.1:1/mimir_sandbox`;
  const file = join(root, 'authority.json');
  writeFileSync(
    file,
    JSON.stringify({
      containerId: 'a'.repeat(64),
      id: '12345678-1234-4234-8234-123456789012',
      image: `postgres@sha256:${'b'.repeat(64)}`,
      paths,
      postgresUrl: url,
      root,
      version: 1,
    }),
  );
  const previous = process.env.MIMIR_SANDBOX_AUTHORITY;
  process.env.MIMIR_SANDBOX_AUTHORITY = file;
  let handle;
  try {
    handle = openPostgres(url, {
      createPool: (config) => {
        seen = config;
        pool = new Pool(config);
        return pool;
      },
      log: (line) => logged.push(line),
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MIMIR_SANDBOX_AUTHORITY;
    } else {
      process.env.MIMIR_SANDBOX_AUTHORITY = previous;
    }
    rmSync(root, { force: true, recursive: true });
  }
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
