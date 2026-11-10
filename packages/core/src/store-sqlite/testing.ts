import { Database } from 'bun:sqlite';

import type { Kysely } from 'kysely';

import type { Store } from '../store';
import type { DB } from '../store-sql/schema';
import { readySqlite } from './client';
import { createSqliteStore } from './dialect';

/**
 * A fresh, migrated SQLite store in this process — the fixture the conformance
 * suites run the SQLite arm on. In memory, so it needs no file and no cleanup;
 * the file-backed behavior (WAL, the cross-process write lock) has its own
 * tests.
 */
export type SqliteTestStore = {
  store: Store;
  db: Kysely<DB>;
  /** The database's bytes as they stand, which a later `createSqliteTestStore` copies. */
  image: () => Uint8Array;
  close: () => Promise<void>;
};

/**
 * A fresh store, or with `image` a copy of the store whose `image` it is: a
 * fixture seeded once can be copied per case instead of seeded again, and a
 * write to one copy reaches no other.
 */
export async function createSqliteTestStore(image?: Uint8Array): Promise<SqliteTestStore> {
  const database =
    image === undefined
      ? new Database(':memory:', { create: true, readwrite: true, strict: true })
      : Database.deserialize(image, { strict: true });
  const handle = await readySqlite(database, ':memory:');
  return {
    close: handle.close,
    db: handle.db,
    image: () => database.serialize(),
    store: createSqliteStore(handle.db),
  };
}
