import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { invariant } from '../errors';
import type { Store } from '../store';
import type { StoreDialect, ValueCodecs } from '../store-sql/dialect';
import type { UpgradeReport } from '../store-sql/migrator';
import {
  readSchemaVersion as readSqlSchemaVersion,
  upgradeSchema as upgradeSqlSchema,
} from '../store-sql/migrator';
import type { DB, Executor, Stored } from '../store-sql/schema';
import { fromStored, toStored } from '../store-sql/schema';
import { createSqlStore } from '../store-sql/store';
import { holdingConnection } from './driver';
import { statements as init } from './migrations/0001-init';

/**
 * The SQLite dialect of the shared SQL store (ADR 0032) — the local tier's
 * answers to everything the query code under `core/store-sql` defers to.
 */

/**
 * The extended result codes a unique-key violation raises. SQLite reports a
 * primary-key collision under its own code, where Postgres folds both into
 * `23505`.
 */
const UNIQUE_VIOLATIONS: ReadonlySet<unknown> = new Set([
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_UNIQUE',
]);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    UNIQUE_VIOLATIONS.has(error.code)
  );
}

/**
 * SQLite stores a boolean as 0 or 1, and a list or a JSON document as JSON
 * text (see the migration).
 */
const codecs: ValueCodecs = {
  bool: {
    decode: (stored) => (fromStored(stored) as unknown) === 1,
    encode: (value) => toStored(value ? 1 : 0),
  },
  json: {
    decode: <T>(stored: Stored<T>) => parseJson<T>(stored),
    encode: (value) => toStored(JSON.stringify(value)),
  },
  list: {
    decode: (stored) => parseJson<string[]>(stored),
    encode: (value) => toStored(JSON.stringify(value)),
  },
};

function parseJson<T>(stored: Stored<T>): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the column holds only the JSON text this codec's encode half wrote.
  return JSON.parse(fromStored(stored) as unknown as string) as T;
}

/** One `PRAGMA foreign_key_check` row: a child row whose parent is missing. */
type ForeignKeyViolation = { table: string; rowid: number; parent: string };

export const sqliteDialect: StoreDialect = {
  // SQLite has no `SET CONSTRAINTS`: the deferred `node.parent_id` key is only
  // checked at COMMIT, so the preview asks for every violation outright and
  // turns the first into the refusal a COMMIT would have raised.
  checkDeferredConstraints: async (tx) => {
    const violations = await sql<ForeignKeyViolation>`pragma foreign_key_check`.execute(tx);
    const first = violations.rows.at(0);
    if (first !== undefined) {
      throw invariant(
        `a ${first.table} row references a missing ${first.parent} row`,
        'the import would leave a dangling reference; nothing was written',
      );
    }
  },
  codecs,
  hasSchemaVersionTable: async (ex) => {
    const probe = await sql<{ present: number }>`
      select 1 as present from sqlite_schema where type = 'table' and name = 'schema_version'
    `.execute(ex);
    return probe.rows.length > 0;
  },
  isUniqueViolation,
  label: 'SQLite',
  // SQLITE_MAX_VARIABLE_NUMBER's default since SQLite 3.32.
  maxParameters: 32_766,
  migrations: { '0001_init': init },
  // A local store migrates forward whenever it is opened (ADR 0032 Decision
  // 3), so a gap only shows to a reader that skipped the opener.
  schemaRemedy: {
    behind: 'open the store with this binary; a local store migrates forward on open',
    missing: 'open the store with this binary; a local store creates its schema on open',
  },
  snapshot: (db, fn) =>
    db
      .transaction()
      .setAccessMode('read only')
      .execute((tx) => holdingConnection(() => fn(tx))),
  // `BEGIN IMMEDIATE` (see ./driver) takes the database's one write lock up
  // front, so a migration step excludes every other writer and upgrader.
  upgrade: (db, fn) => db.transaction().execute((tx) => holdingConnection(() => fn(tx))),
  // Writers serialize on the write lock rather than abort, so there is nothing
  // to replay: a contended write waits out the busy timeout.
  write: (db, fn) => db.transaction().execute((tx) => holdingConnection(() => fn(tx))),
};

/**
 * The SQLite `Store` over one Kysely handle. The caller must have migrated it
 * first ({@link upgradeSchema}); `openSqlite` does both.
 */
export function createSqliteStore(db: Kysely<DB>): Store {
  return createSqlStore(db, sqliteDialect);
}

/** The schema version the SQLite store carries, or `null` when it has none. */
export function readSchemaVersion(ex: Executor): Promise<number | null> {
  return readSqlSchemaVersion(ex, sqliteDialect);
}

/** Apply every pending migration; refuse a schema newer than this binary's. */
export function upgradeSchema(db: Kysely<DB>): Promise<UpgradeReport> {
  return upgradeSqlSchema(db, sqliteDialect);
}
