import { expect, test } from 'bun:test';

import { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';

import { fakeIo } from '../cli/testing';
import type { DB, PostgresHandle, UpgradeReport } from '../core/store-postgres/index';
import { createPgliteDialect } from '../core/store-postgres/pglite';
import type { GlobalConfig } from '../service/config';
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

function injected(): Injected {
  const db = new Kysely<DB>({ dialect: createPgliteDialect(new PGlite()) });
  const opened: string[] = [];
  const open = (url: string): PostgresHandle => {
    opened.push(url);
    // The command closes what it opens; the shared handle outlives the case.
    return { close: () => Promise.resolve(), db };
  };
  return {
    db,
    deps: (global) => ({ openPostgres: open, readConfig: () => global }),
    opened,
  };
}

function config(store: GlobalConfig['store']): GlobalConfig {
  return { serve: {}, store, vault: {} };
}

const POSTGRES = config({ backend: 'postgres', url: 'postgres://localhost/mimir' });

test('store upgrade on a norn install reports that the vault converges on its own', async () => {
  const io = fakeIo();
  const pg = injected();
  // The absent fence is the norn default — the common case for this message.
  const code = await cmdStore(['store', 'upgrade'], io, pg.deps(config({})), 'records');
  expect(code).toBe(0);
  expect(io.out.join('\n')).toContain('nothing to upgrade');
  expect(io.err).toEqual([]);
  // No connection is opened for a backend that has none.
  expect(pg.opened).toEqual([]);
  await pg.db.destroy();
});

test('store upgrade creates the schema, then reports it already current', async () => {
  const io = fakeIo();
  const pg = injected();
  try {
    expect(await cmdStore(['store', 'upgrade'], io, pg.deps(POSTGRES), 'records')).toBe(0);
    expect(io.out.join('\n')).toContain('store: schema upgraded from 0 to 1 (0001_init)');

    const again = fakeIo();
    expect(await cmdStore(['store', 'upgrade'], again, pg.deps(POSTGRES), 'records')).toBe(0);
    expect(again.out.join('\n')).toContain('store: schema at version 1 (already current)');
    expect(pg.opened).toEqual([POSTGRES.store.url ?? '', POSTGRES.store.url ?? '']);
  } finally {
    await pg.db.destroy();
  }
});

test('json format emits the upgrade report', async () => {
  const io = fakeIo();
  const pg = injected();
  try {
    expect(await cmdStore(['store', 'upgrade'], io, pg.deps(POSTGRES), 'json')).toBe(0);
    const parsed = JSON.parse(io.out.join('')) as UpgradeReport;
    expect(parsed).toEqual({ applied: ['0001_init'], from: 0, to: 1 });
  } finally {
    await pg.db.destroy();
  }
});

test('a postgres install with no url refuses by naming the key', async () => {
  const io = fakeIo();
  const pg = injected();
  let message = '';
  try {
    await cmdStore(['store', 'upgrade'], io, pg.deps(config({ backend: 'postgres' })), 'records');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('[store] url');
  expect(message).toContain('docs/guides/postgres-store.md');
  await pg.db.destroy();
});

test('an unusable [store] section is fatal here too', async () => {
  const io = fakeIo();
  const pg = injected();
  let message = '';
  try {
    await cmdStore(
      ['store', 'upgrade'],
      io,
      pg.deps(config({ problem: 'invalid-url' })),
      'records',
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('[store] is unusable (invalid-url)');
  await pg.db.destroy();
});

test('a schema newer than the binary is the migrator refusal, not a silent downgrade', async () => {
  const io = fakeIo();
  const pg = injected();
  try {
    await cmdStore(['store', 'upgrade'], io, pg.deps(POSTGRES), 'records');
    await sql
      .raw("INSERT INTO schema_version (version, applied_at) VALUES (99, '2026-01-01T00:00:00Z')")
      .execute(pg.db);

    let message = '';
    try {
      await cmdStore(['store', 'upgrade'], fakeIo(), pg.deps(POSTGRES), 'records');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('the Postgres store schema is version 99');
    expect(message).toContain('this binary reads version 1');
    // Nothing moved: the store is still on 99.
    const rows = await sql<{
      version: number;
    }>`select max(version) as version from schema_version`.execute(pg.db);
    expect(Number(rows.rows[0]?.version)).toBe(99);
  } finally {
    await pg.db.destroy();
  }
});

test('an unknown subcommand is a usage error naming the expected one', async () => {
  const io = fakeIo();
  const pg = injected();
  let message = '';
  try {
    await cmdStore(['store', 'wat'], io, pg.deps(POSTGRES), 'records');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe('store: unknown subcommand (expected: upgrade)');
  await pg.db.destroy();
});

test('store upgrade rejects a surplus positional before opening anything', async () => {
  const io = fakeIo();
  const pg = injected();
  let message = '';
  try {
    await cmdStore(['store', 'upgrade', 'extra'], io, pg.deps(POSTGRES), 'records');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe('store upgrade takes no arguments');
  // The usage error is refused before the connection is ever opened.
  expect(pg.opened).toEqual([]);
  await pg.db.destroy();
});
