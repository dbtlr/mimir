import { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';

import type { Store } from '../store';
import type { DB } from '../store-sql/schema';
import { openPostgres } from './client';
import { createPostgresStore, upgradeSchema } from './dialect';
import { createPgliteDialect } from './pglite';

/**
 * A fresh, migrated Postgres store in this process — the fixture the conformance
 * suites run the Postgres arm on.
 *
 * PGlite rather than a server because the suite must run everywhere: a test lane
 * that needs a database on the runner is a lane that skips, and a skipped
 * conformance arm proves nothing. It is real PostgreSQL, so the constraints,
 * the isolation level, and the SQLSTATEs under test are the real ones.
 */
export type PostgresTestStore = {
  store: Store;
  db: Kysely<DB>;
  close: () => Promise<void>;
};

/**
 * Data directories the fixtures boot from, each built once per test process.
 *
 * A fresh `new PGlite()` runs initdb, several times slower than booting from a
 * dumped data directory. Every fixture still gets its own database; only the
 * starting state is shared, and a snapshot is never written to. A failure to
 * build one stays cached: it is deterministic, so every fixture reports it.
 */
let emptySnapshot: Promise<Blob> | undefined;
let migratedSnapshot: Promise<Blob> | undefined;

async function dumpOf(pg: PGlite): Promise<Blob> {
  try {
    // Flush to the data files so each boot from the dump skips WAL recovery.
    await pg.exec('checkpoint');
    return await pg.dumpDataDir('none');
  } finally {
    await pg.close();
  }
}

function emptyDataDir(): Promise<Blob> {
  emptySnapshot ??= dumpOf(new PGlite());
  return emptySnapshot;
}

function migratedDataDir(): Promise<Blob> {
  migratedSnapshot ??= (async () => {
    const pg = new PGlite({ loadDataDir: await emptyDataDir() });
    try {
      // Not destroyed: destroying the Kysely handle would close `pg` before the dump.
      await upgradeSchema(new Kysely<DB>({ dialect: createPgliteDialect(pg) }));
    } catch (error) {
      await pg.close();
      throw error;
    }
    return dumpOf(pg);
  })();
  return migratedSnapshot;
}

/**
 * Build this process's migrated snapshot, and the empty one it starts from, so
 * the cost lands in a hook rather than a test (MMR-642).
 *
 * The first build compiles PGlite's WebAssembly and runs initdb: about 0.7 s
 * locally and 1.8 s on the Linux gate. A test that paid it would
 * report a cost that is not its own, and would be the test that times out on a
 * slow runner. Every test file that opens a Postgres store therefore calls this
 * first, as `beforeAll(bootPglite)`; Bun counts a `beforeAll` in the file's time,
 * not a test's. A file that only opens empty databases calls
 * {@link bootEmptyPglite} instead. Opening a store before either has run is
 * refused, so a file that forgets the hook fails when it runs alone.
 */
export async function bootPglite(): Promise<void> {
  await migratedDataDir();
}

/** {@link bootPglite} for a file that opens only empty databases: no migration runs. */
export async function bootEmptyPglite(): Promise<void> {
  await emptyDataDir();
}

/** The snapshot a fixture boots from, refused when no `beforeAll` started building it. */
function booted(snapshot: Promise<Blob> | undefined, boot: string): Promise<Blob> {
  if (snapshot === undefined) {
    throw new Error(
      `the PGlite snapshot is not built: call beforeAll(${boot}) in this test file, so the boot is not paid inside a test`,
    );
  }
  return snapshot;
}

/** A fresh, empty Postgres database in this process: no schema, nothing migrated. */
export async function createEmptyPglite(): Promise<PGlite> {
  return new PGlite({ loadDataDir: await booted(emptySnapshot, 'bootEmptyPglite') });
}

/** A Kysely handle over a fresh, unmigrated database, for tests of the migrator's own callers. */
export async function createEmptyPostgresDb(): Promise<Pick<PostgresTestStore, 'close' | 'db'>> {
  const pg = await createEmptyPglite();
  const db = new Kysely<DB>({ dialect: createPgliteDialect(pg) });
  return {
    close: async () => {
      await db.destroy();
      if (!pg.closed) {
        await pg.close();
      }
    },
    db,
  };
}

export async function createPgliteTestStore(): Promise<PostgresTestStore> {
  const pg = new PGlite({ loadDataDir: await booted(migratedSnapshot, 'bootPglite') });
  const db = new Kysely<DB>({ dialect: createPgliteDialect(pg) });
  // Kysely's destroy is a no-op on a handle that never ran a query, so close
  // the database itself too: a closed store must refuse what follows.
  const close = async () => {
    await db.destroy();
    if (!pg.closed) {
      await pg.close();
    }
  };
  return { close, db, store: createPostgresStore(db) };
}

/**
 * A throwaway schema on a real Postgres server, and the handle that removes it.
 *
 * The real-Postgres lane needs isolation without a database per case, so each
 * case gets its own SQL schema and a connection URL pinned to it through
 * libpq's `options=-c search_path=...`. Every unqualified name the backend uses
 * — including the fresh-store probe, which looks `schema_version` up among
 * `current_schemas` — then resolves inside that schema, so a lane run neither
 * sees nor disturbs anything else in the database.
 */
export type ThrowawaySchema = {
  name: string;
  /** The connection URL with `search_path` pinned to {@link name}. */
  url: string;
  drop: () => Promise<void>;
};

/** `url` with libpq `options` pinning the session search path to `schema`. */
function withSearchPath(url: string, schema: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

export async function createThrowawaySchema(url: string): Promise<ThrowawaySchema> {
  const name = `mimir_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = openPostgres(url);
  try {
    await sql.raw(`CREATE SCHEMA ${name}`).execute(admin.db);
  } finally {
    await admin.close();
  }
  return {
    drop: async () => {
      const cleanup = openPostgres(url);
      try {
        await sql.raw(`DROP SCHEMA ${name} CASCADE`).execute(cleanup.db);
      } finally {
        await cleanup.close();
      }
    },
    name,
    url: withSearchPath(url, name),
  };
}
