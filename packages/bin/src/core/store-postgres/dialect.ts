import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Store } from '../store';
import type { StoreDialect, ValueCodecs } from '../store-sql/dialect';
import type { UpgradeReport } from '../store-sql/migrator';
import {
  assertSchemaCurrent as assertSqlSchemaCurrent,
  readSchemaVersion as readSqlSchemaVersion,
  SCHEMA_VERSION,
  upgradeSchema as upgradeSqlSchema,
} from '../store-sql/migrator';
import type { DB, Executor } from '../store-sql/schema';
import { fromStored, toStored } from '../store-sql/schema';
import { createSqlStore } from '../store-sql/store';
import { statements as init } from './migrations/0001-init';
import { serializable, snapshotRead } from './tx';

/**
 * The Postgres dialect of the shared SQL store (ADR 0030, ADR 0032) —
 * everything Postgres-specific the query code under `core/store-sql` defers to
 * — and that store and its schema gate bound to it, which is the surface the
 * barrel exports.
 */

/** PostgreSQL SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * The advisory-lock key an upgrade serializes on. An arbitrary constant, fixed
 * forever: two binaries must pick the SAME number or they do not exclude each
 * other.
 */
const UPGRADE_LOCK = 379_231_001;

/**
 * The probe SCANS `pg_class` rather than calling `to_regclass`. `to_regclass` is
 * a syscache lookup, and a negative lookup a connection already made can still
 * be cached when a later transaction on that same connection asks again — which
 * is precisely the losing side of a concurrent upgrade, where the table appeared
 * between the two asks. Reading `pg_class` as a relation takes a lock on it, and
 * that is what makes the backend accept the other connection's invalidation
 * messages and answer from the current catalog.
 */
const hasSchemaVersionTable: StoreDialect['hasSchemaVersionTable'] = async (ex) => {
  const probe = await sql<{ present: string }>`
    select c.oid::text as present
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relname = 'schema_version'
       and n.nspname = any(current_schemas(false))
  `.execute(ex);
  return probe.rows.length > 0;
};

/**
 * Both drivers (`pg` and PGlite) already speak the store's shapes: a `boolean`
 * is a boolean, a `text[]` is a string array, and a `jsonb` is parsed on read.
 * The one encoding is a `jsonb` write, handed over as JSON text so the driver
 * never has to guess the parameter's type.
 */
const codecs: ValueCodecs = {
  bool: { decode: fromStored, encode: toStored },
  json: { decode: fromStored, encode: (value) => toStored(JSON.stringify(value)) },
  list: { decode: fromStored, encode: toStored },
};

export const postgresDialect: StoreDialect = {
  // Force the deferred constraints (the `node.parent_id` foreign key) now.
  checkDeferredConstraints: async (tx) => {
    await sql`set constraints all immediate`.execute(tx);
  },
  codecs,
  hasSchemaVersionTable,
  isUniqueViolation,
  label: 'Postgres',
  maxParameters: 65_535,
  migrations: { '0001_init': init },
  // A shared store upgrades by one explicit act, never as a side effect of a
  // binary opening it (ADR 0030).
  schemaRemedy: {
    behind: `run 'mimir store upgrade' on one machine; every binary must be at least version ${String(SCHEMA_VERSION)}`,
    missing: "run 'mimir store upgrade' to create it",
  },
  snapshot: snapshotRead,
  upgrade: (db, fn) =>
    db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(${UPGRADE_LOCK}::bigint)`.execute(tx);
      return fn(tx);
    }),
  write: serializable,
};

/**
 * The Postgres `Store` (ADR 0030) over one Kysely handle. The caller must have
 * passed the schema gate ({@link assertSchemaCurrent}) first.
 */
export function createPostgresStore(db: Kysely<DB>): Store {
  return createSqlStore(db, postgresDialect);
}

/** The schema version the Postgres store carries, or `null` when it has none. */
export function readSchemaVersion(ex: Executor): Promise<number | null> {
  return readSqlSchemaVersion(ex, postgresDialect);
}

/** Refuse a Postgres store whose schema this binary does not exactly match. */
export function assertSchemaCurrent(db: Kysely<DB>): Promise<void> {
  return assertSqlSchemaCurrent(db, postgresDialect);
}

/** Apply every pending migration — `mimir store upgrade`, the one explicit act. */
export function upgradeSchema(db: Kysely<DB>): Promise<UpgradeReport> {
  return upgradeSqlSchema(db, postgresDialect);
}
