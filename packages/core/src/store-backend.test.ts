import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPath } from './config';
import { MimirError } from './errors';
import { sandboxPostgresUrlFromEnvironment } from './sandbox-authority';
import { buildStore } from './store-backend';
import { openPostgres, upgradeSchema } from './store-postgres/index';
import { createThrowawaySchema } from './store-postgres/testing';
import { buildSqliteStore } from './store-sqlite-backend';

/**
 * The store composition root (ADR 0030, ADR 0032): `[store] backend` fences which backend
 * an install runs on, and the built store exposes that backend's doctor facet
 * rather than any backend-typed member.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-backend-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

// The per-install backend fence (ADR 0030 Decision 1). A Postgres install needs
// a connection URL: the fence alone names no database, and falling back to the
// local store would silently open the wrong one.
test('the postgres backend refuses without [store] url', async () => {
  let threw = false;
  try {
    await buildStore({ store: { backend: 'postgres' } });
  } catch (error) {
    threw = true;
    const message = (error as Error).message;
    expect(message).toContain('[store] url');
    expect(message).toContain(configPath());
    expect(message).toContain('docs/guides/postgres-store.md');
  }
  expect(threw).toBe(true);
});

/**
 * The schema gate at the composition root (ADR 0030 Decision 5). Needs a real
 * server, because the point is a database a previous run never touched: PGlite
 * would be a fresh store either way, and the gate's whole job is to tell a
 * fresh store from one an older binary already wrote.
 */
const POSTGRES_URL = sandboxPostgresUrlFromEnvironment();

test.skipIf(POSTGRES_URL === undefined)(
  'a postgres build refuses an unmigrated store, then builds once store upgrade has run',
  async () => {
    const schema = await createThrowawaySchema(POSTGRES_URL ?? '');
    const config = {
      store: { backend: 'postgres' as const, url: schema.url },
    };
    try {
      let refusal = '';
      try {
        await buildStore(config);
      } catch (error) {
        refusal = (error as Error).message;
      }
      expect(refusal).toContain('the Postgres store has no schema');

      const handle = openPostgres(schema.url);
      try {
        await upgradeSchema(handle.db);
      } finally {
        await handle.close();
      }

      const built = await buildStore(config);
      try {
        expect((await built.store.loadWorkingSet()).nodes).toEqual([]);
        // The backend supplies its own doctor facet.
        expect((await built.doctor.diagnose(undefined)).findings).toEqual([]);
      } finally {
        await built.close();
      }
    } finally {
      await schema.drop();
    }
  },
);

// The default arm (ADR 0032): no vault, no norn, nothing but a file the open
// creates. Built over a temporary path — the composition root's own path is
// the installation's data directory.
test('the sqlite arm creates its database on first build and reads it back', async () => {
  const path = join(dir, 'data', 'mimir.db');
  const first = await buildSqliteStore(path);
  try {
    expect((await first.store.loadWorkingSet()).nodes).toEqual([]);
    expect((await first.doctor.diagnose(undefined)).findings).toEqual([]);
    await first.store.transact((writer) =>
      writer.insertProject({ description: null, key: 'MMR', name: 'Mimir', tags: [] }),
    );
  } finally {
    await first.close();
  }
  expect(existsSync(path)).toBe(true);

  const second = await buildSqliteStore(path);
  try {
    expect((await second.store.loadProjects()).map((project) => project.key)).toEqual(['MMR']);
  } finally {
    await second.close();
  }
});

// A helper beside the store's owner opens the owner's store or nothing: the
// existing-only arm never creates the data directory or the file.
test('an existing-only sqlite build refuses a missing store and creates nothing', async () => {
  const path = join(dir, 'data', 'store.sqlite');
  let refusal = '';
  try {
    await buildStore({ store: { backend: 'sqlite' } }, { existing: true, sqliteFile: path });
  } catch (error) {
    refusal = (error as Error).message;
  }
  expect(refusal).toContain(`no store at ${path}`);
  expect(existsSync(join(dir, 'data'))).toBe(false);

  await (await buildSqliteStore(path)).close();
  const built = await buildStore(
    { store: { backend: 'sqlite' } },
    { existing: true, sqliteFile: path },
  );
  try {
    expect(await built.tokens.list()).toEqual([]);
  } finally {
    await built.close();
  }
});

test('an unusable [store] section is fatal, never a fallback to another store', async () => {
  // The fence selects which store gets WRITTEN: a typo in a Postgres install
  // must not create and write a local store instead.
  for (const [problem, remedy] of [
    ['invalid-backend', 'set backend to one of: sqlite, postgres'],
    ['malformed', 'set backend to one of: sqlite, postgres'],
    // A bad url is a different fault and gets a different remedy: re-reading
    // the list of backends does not fix a connection string.
    ['invalid-url', 'set url to a Postgres connection URL'],
  ] as const) {
    let threw = false;
    try {
      await buildStore({ store: { problem } });
    } catch (error) {
      threw = true;
      // A MimirError, so every transport renders the summary and the remedy as
      // a refusal rather than crashing on an unknown error.
      expect(error).toBeInstanceOf(MimirError);
      expect((error as MimirError).message).toContain(`[store] is unusable (${problem})`);
      expect((error as MimirError).message).toContain(configPath());
      expect((error as MimirError).hint).toContain(remedy);
    }
    expect(threw).toBe(true);
  }
});

// Each store has one owner (ADR 0038): an install that names a host keeps no
// local store, so a CLI that cannot reach the host opens none in its place.
test('a config with a usable [host] builds no local store', async () => {
  const refusal: unknown = await buildStore({
    host: { url: 'https://mimir.example.test' },
    store: {},
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(MimirError);
  expect((refusal as MimirError).message).toContain(`[host] is set in ${configPath()}`);
  expect((refusal as MimirError).hint).toBe(
    'use a mimir release with remote mode, or remove [host] to use a local store',
  );
});

// A broken `[host]` is refused with its own fix, as remote mode would refuse it.
test('a config with a broken [host] builds no local store and names the fix', async () => {
  for (const [host, hint] of [
    [{ problem: 'invalid-url' }, "set [host] url to the host's http or https URL"],
    [{ problem: 'with-store' }, 'keep one: remove [store] to use the host'],
  ] as const) {
    const refusal: unknown = await buildStore({ host, store: {} }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MimirError);
    expect((refusal as MimirError).hint).toStartWith(hint);
  }
});

test('a removed norn backend names the removal and the export path to migrate', async () => {
  let message = '';
  try {
    await buildStore({ store: { problem: 'removed-backend' } });
  } catch (error) {
    message = error instanceof MimirError ? `${error.message} — ${error.hint ?? ''}` : '';
  }
  expect(message).toContain('[store] is unusable (removed-backend)');
  expect(message).toContain('the norn backend was removed');
  expect(message).toContain('store export');
  expect(message).toContain(configPath());
});
