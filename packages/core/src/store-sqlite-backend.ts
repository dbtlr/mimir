/**
 * The SQLite backend arm of the store composition root (ADR 0032) — the local
 * tier, and the default. It opens the installation's one database file, which
 * migrates it forward, and pairs the store with the shared SQL doctor facet.
 * `close` releases the database. Nothing outside the binary is needed: no
 * external tool, no server.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createSqlDoctorBackend } from './doctor/sql/backend';
import { sqliteStorePath } from './env';
import type { BuiltStore } from './store-backend';
import type { SqliteHandle } from './store-sqlite/index';
import { createSqliteStore, openSqlite, sqliteDialect } from './store-sqlite/index';

/** Build the SQLite store for this process over the installation's database
 * file, migrating it forward on open. */
export async function buildSqliteStore(
  path: string = sqliteStorePath(),
  onMigration?: (name: string) => void,
): Promise<BuiltStore> {
  return builtOver(await openInstallationSqlite(path, onMigration));
}

/** The store, its doctor facet, and its release over one open handle. */
function builtOver(handle: SqliteHandle): BuiltStore {
  return {
    close: () => handle.close(),
    doctor: createSqlDoctorBackend(handle.db, sqliteDialect),
    store: createSqliteStore(handle.db),
  };
}

/**
 * Open the installation's SQLite store — the one opener the composition root
 * and `store upgrade` share. A fresh installation's data directory may not
 * exist until this first open.
 */
export function openInstallationSqlite(
  path: string = sqliteStorePath(),
  onMigration?: (name: string) => void,
): Promise<SqliteHandle> {
  mkdirSync(dirname(path), { recursive: true });
  return openSqlite(path, { onMigration });
}
