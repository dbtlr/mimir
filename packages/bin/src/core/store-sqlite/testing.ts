import type { Kysely } from 'kysely';

import type { Store } from '../store';
import type { DB } from '../store-sql/schema';
import { openSqlite } from './client';
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
  close: () => Promise<void>;
};

export async function createSqliteTestStore(): Promise<SqliteTestStore> {
  const handle = await openSqlite(':memory:');
  return { close: handle.close, db: handle.db, store: createSqliteStore(handle.db) };
}
