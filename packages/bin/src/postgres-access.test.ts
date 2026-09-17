import { expect, test } from 'bun:test';

import { openPostgres } from './core/store-postgres/client';

test('an uninstalled source process refuses Postgres before creating a pool', () => {
  const saved = process.env.MIMIR_SANDBOX_AUTHORITY;
  delete process.env.MIMIR_SANDBOX_AUTHORITY;
  let pools = 0;
  try {
    expect(() =>
      openPostgres('postgres://live:secret@production.invalid/live', {
        createPool: () => {
          pools++;
          throw new Error('Pool creation must not occur');
        },
      }),
    ).toThrow('registered live installation or a launcher-owned sandbox');
    expect(pools).toBe(0);
  } finally {
    if (saved === undefined) {
      delete process.env.MIMIR_SANDBOX_AUTHORITY;
    } else {
      process.env.MIMIR_SANDBOX_AUTHORITY = saved;
    }
  }
});
