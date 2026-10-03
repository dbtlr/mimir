/**
 * The SQLite backend arm of the store composition root (ADR 0032) — the local
 * tier, and the default. It opens the installation's one database file, which
 * migrates it forward, and pairs the store with the shared SQL doctor facet.
 * `close` releases the database. Nothing outside the binary is needed: no
 * external tool, no server.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SqliteHandle } from './core/store-sqlite/index';
import { createSqliteStore, openSqlite, sqliteDialect } from './core/store-sqlite/index';
import { createSqlDoctorBackend } from './doctor/sql/backend';
import { sqliteStorePath } from './env';
import type { BuildStoreOptions, BuiltStore } from './store-backend';

/**
 * Build the SQLite store for this process. Like the Postgres arm, its doctor
 * has no repair pass, so `opts` is deliberately unused.
 */
export async function buildSqliteStore(
  _opts: BuildStoreOptions,
  path: string = sqliteStorePath(),
): Promise<BuiltStore> {
  const handle = await openInstallationSqlite(path);
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
export function openInstallationSqlite(path: string = sqliteStorePath()): Promise<SqliteHandle> {
  mkdirSync(dirname(path), { recursive: true });
  return openSqlite(path);
}
