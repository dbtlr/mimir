import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MimirError } from './core/errors';
import { openPostgres, upgradeSchema } from './core/store-postgres/index';
import { createThrowawaySchema } from './core/store-postgres/testing';
import { sandboxPostgresUrlFromEnvironment } from './sandbox-authority';
import { configPath } from './service/config';
import { buildStore } from './store-backend';
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
    await buildStore({ serve: {}, store: { backend: 'postgres' } });
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
      serve: {},
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
      await buildStore({ serve: {}, store: { problem } });
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

test('a removed norn backend names the removal and the export path to migrate', async () => {
  let message = '';
  try {
    await buildStore({ serve: {}, store: { problem: 'removed-backend' } });
  } catch (error) {
    message = error instanceof MimirError ? `${error.message} — ${error.hint ?? ''}` : '';
  }
  expect(message).toContain('[store] is unusable (removed-backend)');
  expect(message).toContain('the norn backend was removed');
  expect(message).toContain('store export');
  expect(message).toContain(configPath());
});

// `serve --store <file>` opens a named SQLite file for one run — the docs
// fixture, never an installation's own store. A named file must already exist:
// a typo that quietly created an empty store would serve the wrong board.
test('a named store file opens that SQLite file instead of the installation store', async () => {
  const path = join(dir, 'fixture.sqlite');
  const seeded = await buildSqliteStore(path);
  try {
    await seeded.store.transact((writer) =>
      writer.insertProject({ description: null, key: 'AUR', name: 'Aurora', tags: [] }),
    );
  } finally {
    await seeded.close();
  }

  const built = await buildStore({ serve: {}, store: {} }, { file: path });
  try {
    expect((await built.store.loadProjects()).map((project) => project.key)).toEqual(['AUR']);
  } finally {
    await built.close();
  }
});

test('a named store file that does not exist is refused, never created', async () => {
  const path = join(dir, 'missing.sqlite');
  let message = '';
  try {
    await buildStore({ serve: {}, store: {} }, { file: path });
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    message = (error as MimirError).message;
  }
  expect(message).toContain(path);
  expect(existsSync(path)).toBe(false);
});

test('a named store file is refused on a postgres install', async () => {
  const path = join(dir, 'fixture.sqlite');
  let message = '';
  try {
    await buildStore(
      { serve: {}, store: { backend: 'postgres', url: 'postgres://unused' } },
      { file: path },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    message = (error as MimirError).message;
  }
  expect(message).toContain('--store');
  expect(message).toContain('postgres');
});

/** Refusal message of a named-file build, or '' when it opened. */
async function namedRefusal(path: string): Promise<string> {
  try {
    const built = await buildStore({ serve: {}, store: {} }, { file: path });
    await built.close();
    return '';
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    return (error as MimirError).message;
  }
}

test('a named store file must be a Mimir store, not a directory or another file', async () => {
  const folder = join(dir, 'folder');
  mkdirSync(folder);
  expect(await namedRefusal(folder)).toContain('not a Mimir SQLite store');

  const notes = join(dir, 'notes.md');
  writeFileSync(notes, 'irreplaceable\n');
  expect(await namedRefusal(notes)).toContain('not a Mimir SQLite store');
});

// A named file is never migrated: serving a store from a branch whose schema
// moved ahead would upgrade it past the binary that owns it.
test("a named store file behind this binary's schema is refused, not migrated", async () => {
  const path = join(dir, 'old.sqlite');
  const seeded = await buildSqliteStore(path);
  await seeded.close();
  const raw = new Database(path);
  raw.run('delete from schema_version');
  raw.run(
    "insert into schema_version (version, applied_at) values (0, '2026-01-01T00:00:00.000Z')",
  );
  raw.close();

  expect(await namedRefusal(path)).toContain('schema is version 0');
  const after = new Database(path, { readonly: true });
  try {
    expect(after.query('select version from schema_version').all()).toEqual([{ version: 0 }]);
  } finally {
    after.close();
  }
});
