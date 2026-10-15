import { expect, test } from 'bun:test';

import { openSqlite, SCHEMA_VERSION } from '@mimir/core';
import type { DB, GlobalConfig, PostgresHandle, UpgradeReport } from '@mimir/core';
import { createPgliteDialect, createEmptyPglite } from '@mimir/core/testing';
import { Kysely, sql } from 'kysely';

import { fakeIo } from '../cli/testing';
import type { StoreDeps } from './commands';
import { cmdStore } from './commands';

/**
 * `store upgrade` over an in-process Postgres. The command's job is the fence
 * (which backend is this install on?) and the report; the migration itself is
 * the migrator's, tested there. The injected handle is deliberately one shared
 * database with a no-op `close`, so two invocations see each other's work the
 * way two runs against a real server would.
 */

type Injected = { deps: (config: GlobalConfig) => StoreDeps; db: Kysely<DB>; opened: string[] };

async function injected(): Promise<Injected> {
  const db = new Kysely<DB>({ dialect: createPgliteDialect(await createEmptyPglite()) });
  const opened: string[] = [];
  const open = (url: string): PostgresHandle => {
    opened.push(url);
    // The command closes what it opens; the shared handle outlives the case.
    return { close: () => Promise.resolve(), db };
  };
  return {
    db,
    deps: (global) => ({
      openPostgres: open,
      openSqlite: () => {
        opened.push('sqlite');
        return openSqlite(':memory:');
      },
      readConfig: () => global,
      readStdin: () => Promise.reject(new Error('store upgrade must not read stdin')),
    }),
    opened,
  };
}

function config(store: GlobalConfig['store']): GlobalConfig {
  return { serve: {}, store };
}

/** `store upgrade` moves a schema, never data: it must never reach for the
 * store the transfer verbs route through (MMR-380). */
const noStore = (): never => {
  throw new Error('store upgrade must not open the data store');
};

const POSTGRES = config({ backend: 'postgres', url: 'postgres://localhost/mimir' });

test('store upgrade on the default sqlite install opens the database and reports the migration', async () => {
  const io = fakeIo();
  const pg = await injected();
  try {
    // The absent fence is the sqlite default; opening the file migrates it.
    expect(await cmdStore(['store', 'upgrade'], {}, io, pg.deps(config({})), 'json', noStore)).toBe(
      0,
    );
    expect(JSON.parse(io.out.join(''))).toEqual({
      applied: [
        '0001_init',
        '0002_grooming',
        '0003_block_owner',
        '0004_seed_parked',
        '0005_project_pinned',
      ],
      from: 0,
      to: SCHEMA_VERSION,
    });
    expect(pg.opened).toEqual(['sqlite']);
  } finally {
    await pg.db.destroy();
  }
});

test('store upgrade creates the schema, then reports it already current', async () => {
  const io = fakeIo();
  const pg = await injected();
  try {
    expect(
      await cmdStore(['store', 'upgrade'], {}, io, pg.deps(POSTGRES), 'records', noStore),
    ).toBe(0);
    expect(io.out.join('\n')).toContain(
      'store: schema upgraded from 0 to 5 (0001_init, 0002_grooming, 0003_block_owner, 0004_seed_parked, 0005_project_pinned)',
    );

    const again = fakeIo();
    expect(
      await cmdStore(['store', 'upgrade'], {}, again, pg.deps(POSTGRES), 'records', noStore),
    ).toBe(0);
    expect(again.out.join('\n')).toContain('store: schema at version 5 (already current)');
    expect(pg.opened).toEqual([POSTGRES.store.url ?? '', POSTGRES.store.url ?? '']);
  } finally {
    await pg.db.destroy();
  }
});

test('json format emits the upgrade report', async () => {
  const io = fakeIo();
  const pg = await injected();
  try {
    expect(await cmdStore(['store', 'upgrade'], {}, io, pg.deps(POSTGRES), 'json', noStore)).toBe(
      0,
    );
    const parsed = JSON.parse(io.out.join('')) as UpgradeReport;
    expect(parsed).toEqual({
      applied: [
        '0001_init',
        '0002_grooming',
        '0003_block_owner',
        '0004_seed_parked',
        '0005_project_pinned',
      ],
      from: 0,
      to: 5,
    });
  } finally {
    await pg.db.destroy();
  }
});

test('a postgres install with no url refuses by naming the key', async () => {
  const io = fakeIo();
  const pg = await injected();
  let message = '';
  try {
    await cmdStore(
      ['store', 'upgrade'],
      {},
      io,
      pg.deps(config({ backend: 'postgres' })),
      'records',
      noStore,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('[store] url');
  expect(message).toContain('docs/guides/postgres-store.md');
  await pg.db.destroy();
});

test('an unusable [store] section is fatal here too', async () => {
  const io = fakeIo();
  const pg = await injected();
  let message = '';
  try {
    await cmdStore(
      ['store', 'upgrade'],
      {},
      io,
      pg.deps(config({ problem: 'invalid-url' })),
      'records',
      noStore,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('[store] is unusable (invalid-url)');
  await pg.db.destroy();
});

test('a schema newer than the binary is the migrator refusal, not a silent downgrade', async () => {
  const io = fakeIo();
  const pg = await injected();
  try {
    await cmdStore(['store', 'upgrade'], {}, io, pg.deps(POSTGRES), 'records', noStore);
    await sql
      .raw("INSERT INTO schema_version (version, applied_at) VALUES (99, '2026-01-01T00:00:00Z')")
      .execute(pg.db);

    let message = '';
    try {
      await cmdStore(['store', 'upgrade'], {}, fakeIo(), pg.deps(POSTGRES), 'records', noStore);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('the Postgres store schema is version 99');
    expect(message).toContain('this binary reads version 5');
    // Nothing moved: the store is still on 99.
    const rows = await sql<{
      version: number;
    }>`select max(version) as version from schema_version`.execute(pg.db);
    expect(Number(rows.rows[0]?.version)).toBe(99);
  } finally {
    await pg.db.destroy();
  }
});

test('an unknown subcommand is a usage error naming every subcommand', async () => {
  const io = fakeIo();
  const pg = await injected();
  let message = '';
  try {
    await cmdStore(['store', 'wat'], {}, io, pg.deps(POSTGRES), 'records', noStore);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe('store: unknown subcommand (expected: upgrade | export | import)');
  await pg.db.destroy();
});

test('store upgrade rejects a surplus positional before opening anything', async () => {
  const io = fakeIo();
  const pg = await injected();
  let message = '';
  try {
    await cmdStore(['store', 'upgrade', 'extra'], {}, io, pg.deps(POSTGRES), 'records', noStore);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe('store upgrade takes no arguments');
  // The usage error is refused before the connection is ever opened.
  expect(pg.opened).toEqual([]);
  await pg.db.destroy();
});
