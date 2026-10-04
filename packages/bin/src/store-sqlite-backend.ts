/**
 * The SQLite backend arm of the store composition root (ADR 0032) — the local
 * tier, and the default. It opens the installation's one database file, which
 * migrates it forward, and pairs the store with the shared SQL doctor facet.
 * `close` releases the database. Nothing outside the binary is needed: no
 * external tool, no server.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { invariant, MimirError } from './core/errors';
import type { SqliteHandle } from './core/store-sqlite/index';
import {
  createSqliteStore,
  openExistingSqlite,
  openSqlite,
  sqliteDialect,
} from './core/store-sqlite/index';
import { createSqlDoctorBackend } from './doctor/sql/backend';
import { sqliteStorePath } from './env';
import type { BuiltStore } from './store-backend';

/** Build the SQLite store for this process over the installation's database
 * file, migrating it forward on open. */
export async function buildSqliteStore(path: string = sqliteStorePath()): Promise<BuiltStore> {
  return builtOver(await openInstallationSqlite(path));
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
export function openInstallationSqlite(path: string = sqliteStorePath()): Promise<SqliteHandle> {
  mkdirSync(dirname(path), { recursive: true });
  return openSqlite(path);
}

/**
 * Build the store over a SQLite file a run named (`serve --store`) rather than
 * the installation's own. The file must already be a Mimir store at exactly
 * this binary's schema, and it is never migrated: serving a store from a branch
 * whose schema moved ahead would upgrade it past the binary that owns it.
 */
export async function buildNamedSqliteStore(file: string): Promise<BuiltStore> {
  if (!existsSync(file)) {
    throw invariant(`no store file at ${file}`, 'name an existing SQLite store file');
  }
  if (!statSync(file).isFile()) {
    throw notAStore(file, 'a directory');
  }
  try {
    return builtOver(await openExistingSqlite(file));
  } catch (error) {
    if (error instanceof MimirError) {
      throw invariant(
        `${error.message} in ${file}; a named store file is never migrated`,
        'serve it with the binary that wrote it, or regenerate it with this one',
      );
    }
    throw notAStore(file, error instanceof Error ? error.message : String(error));
  }
}

function notAStore(file: string, reason: string): MimirError {
  return invariant(
    `${file} is not a Mimir SQLite store (${reason})`,
    'name a store file this binary created, such as the docs fixture',
  );
}
