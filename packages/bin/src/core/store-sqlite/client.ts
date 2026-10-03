import { Database } from 'bun:sqlite';

import { Kysely, sql } from 'kysely';

import { invariant } from '../errors';
import type { UpgradeReport } from '../store-sql/migrator';
import type { DB } from '../store-sql/schema';
import { readSchemaVersion, sqliteDialect, upgradeSchema } from './dialect';
import type { BunSqliteOptions } from './driver';
import { createBunSqliteDialect, WRITE_WAIT_MS, whileBusy } from './driver';

/**
 * The local SQLite store's connection (ADR 0032) — one database file, opened
 * in WAL mode with foreign keys enforced, and migrated forward before anything
 * reads it.
 */

/**
 * The file the local store keeps in the installation's data directory. Not
 * `mimir.db`: that is where the SQLite store retired at ADR 0016 kept its
 * tables, and an installation that predates the retirement may still hold it.
 */
export const SQLITE_FILE = 'store.sqlite';

/**
 * SQLite's own busy timeout, which waits synchronously. Opening may wait this
 * long — several processes opening a fresh file contend for the journal-mode
 * switch, and nothing is being served yet. Once open, writers wait for the lock
 * asynchronously in the driver ({@link BunSqliteOptions}), so the timeout drops
 * to a token that only absorbs a momentary lock.
 */
const OPEN_BUSY_TIMEOUT_MS = 5000;
const OPEN_STORE_BUSY_TIMEOUT_MS = 10;

export type SqliteHandle = {
  db: Kysely<DB>;
  /** What opening the store migrated — `applied` is empty on a current store. */
  upgrade: UpgradeReport;
  close: () => Promise<void>;
};

/**
 * Open (creating it when absent) and migrate the SQLite store at `path`, whose
 * directory must exist. `:memory:` opens a private in-process store, as the
 * tests use.
 *
 * The migration runs inside a write transaction, so a failed step leaves the
 * old schema intact, and it refuses a store whose schema is newer than this
 * binary's (ADR 0032 Decision 3).
 */
export async function openSqlite(
  path: string,
  options: BunSqliteOptions = {},
): Promise<SqliteHandle> {
  const database = new Database(path, { create: true, strict: true });
  // Foreign keys and the busy timeout are per connection and must be set on
  // every open; neither writes to the file.
  database.run('pragma foreign_keys = on');
  database.run(`pragma busy_timeout = ${String(OPEN_BUSY_TIMEOUT_MS)}`);
  const db = new Kysely<DB>({ dialect: createBunSqliteDialect(database, options) });
  try {
    // Before the journal mode, which does write: a refused file is left
    // exactly as it was found.
    await refuseForeignDatabase(db, path);
    // WAL lets a reader keep its snapshot while a writer commits. It is a
    // property of the file, so this is a no-op after the first open.
    // The switch needs the file to itself, and SQLite can refuse it at once
    // while other openers hold it rather than wait, so it is retried.
    await whileBusy(options.writeWaitMs ?? WRITE_WAIT_MS, () =>
      database.run('pragma journal_mode = wal'),
    );
    const upgrade = await upgradeSchema(db);
    database.run(`pragma busy_timeout = ${String(OPEN_STORE_BUSY_TIMEOUT_MS)}`);
    return { close: () => db.destroy(), db, upgrade };
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

/**
 * Refuse a file that holds tables but no schema version: some other database,
 * not an empty file to create the store in. Migrating it would fail partway or
 * build the store beside data that is not its own.
 */
async function refuseForeignDatabase(db: Kysely<DB>, path: string): Promise<void> {
  // Both reads under the write lock. Apart, another process creating the
  // schema between them would read as tables with no version — a stranger's
  // file. A read snapshot is not enough either: another opener switching the
  // file to WAL can fail a reader mid-transaction without SQLite's busy wait,
  // where a write-lock request is retried (see ./driver).
  const foreign = await sqliteDialect.write(db, async (tx) => {
    if ((await readSchemaVersion(tx)) !== null) {
      return false;
    }
    const tables = await sql<{ name: string }>`
      select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'
    `.execute(tx);
    return tables.rows.length > 0;
  });
  if (foreign) {
    throw invariant(
      `${path} is not a Mimir store: it holds tables but no schema version`,
      'move the file aside; the store is created fresh on the next open',
    );
  }
}
