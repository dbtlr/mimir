/**
 * The SQLite backend arm of the store composition root (ADR 0032) — the local
 * tier, and the default. It opens the installation's one database file, which
 * migrates it forward, and pairs the store with the shared SQL doctor facet.
 * `close` releases the database. Nothing outside the binary is needed: no
 * external tool, no server.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { invariant } from './core/errors';
import { SCHEMA_VERSION } from './core/store-sql/migrator';
import type { SqliteHandle } from './core/store-sqlite/index';
import { createSqliteStore, openSqlite, sqliteDialect } from './core/store-sqlite/index';
import { createSqlDoctorBackend } from './doctor/sql/backend';
import { sqliteStorePath } from './env';
import type { BuiltStore } from './store-backend';

/** Build the SQLite store for this process over the installation's database
 * file, migrating it forward on open. */
export async function buildSqliteStore(path: string = sqliteStorePath()): Promise<BuiltStore> {
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

/**
 * Build the store over a SQLite file a run named (`serve --store`) rather than
 * the installation's own. The file must already be a Mimir store at exactly
 * this binary's schema: opening migrates, and a named file is never migrated —
 * serving a store from a branch whose schema moved ahead would upgrade it past
 * the binary that owns it. The check reads the file read-only first.
 */
export async function buildNamedSqliteStore(file: string): Promise<BuiltStore> {
  if (!existsSync(file)) {
    throw invariant(`no store file at ${file}`, 'name an existing SQLite store file');
  }
  const version = statSync(file).isFile() ? readNamedSchemaVersion(file) : null;
  if (version === null) {
    throw invariant(
      `${file} is not a Mimir SQLite store`,
      'name a store file this binary created, such as the docs fixture',
    );
  }
  if (version !== SCHEMA_VERSION) {
    throw invariant(
      `the store schema is version ${String(version)} in ${file}; this binary serves version ${String(SCHEMA_VERSION)} and never migrates a named file`,
      'serve it with the binary that wrote it, or regenerate it with this one',
    );
  }
  return await buildSqliteStore(file);
}

/** The schema version recorded in `file`, or `null` when it is not a store. */
function readNamedSchemaVersion(file: string): number | null {
  let database: Database | undefined;
  try {
    database = new Database(file, { readonly: true });
    const row = database
      .query<{ version: number | null }, []>('select max(version) as version from schema_version')
      .get();
    return row?.version ?? null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
