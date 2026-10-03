import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { invariant } from '../errors';
import { now } from '../time';
import type { Migration } from './migrations';
import { MIGRATIONS } from './migrations';
import type { DB } from './schema';

/**
 * The schema gate (ADR 0030). A Postgres store is shared by several machines,
 * each running its own binary, so "which schema is this?" is a question every
 * connection must answer before it reads a row.
 *
 * The posture is: a binary NEVER migrates implicitly. It refuses a schema newer
 * than it understands (it would misread columns it does not know about) and it
 * refuses an older one (it would write columns the other binaries cannot read).
 * `mimir store upgrade` is the one explicit act that moves the schema, run once
 * on one machine after every binary is new enough to live with the result.
 */

/** The schema version this binary reads and writes. */
export const SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * The advisory-lock key `upgradeSchema` serializes on. An arbitrary constant,
 * fixed forever: two binaries must pick the SAME number or they do not exclude
 * each other.
 */
const UPGRADE_LOCK = 379_231_001;

/**
 * The schema version stored in the database, or `null` when the store carries
 * no schema at all.
 *
 * Absence is PROBED, never caught from a failed select. Inside a transaction an
 * undefined-table error aborts the whole scope, and the upgrade reads the
 * version inside the transaction that is about to create the table — so a catch
 * here would poison the very migration it guards.
 *
 * The probe SCANS `pg_class` rather than calling `to_regclass`. `to_regclass` is
 * a syscache lookup, and a negative lookup a connection already made can still
 * be cached when a later transaction on that same connection asks again — which
 * is precisely the losing side of a concurrent upgrade, where the table appeared
 * between the two asks. Reading `pg_class` as a relation takes a lock on it, and
 * that is what makes the backend accept the other connection's invalidation
 * messages and answer from the current catalog.
 */
export async function readSchemaVersion(db: Kysely<DB>): Promise<number | null> {
  const probe = await sql<{ present: string }>`
    select c.oid::text as present
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relname = 'schema_version'
       and n.nspname = any(current_schemas(false))
  `.execute(db);
  if (probe.rows.length === 0) {
    return null;
  }
  const row = await db
    .selectFrom('schema_version')
    .select((eb) => eb.fn.max('version').as('version'))
    .executeTakeFirst();
  return row?.version ?? null;
}

/** Refuse to use a store whose schema this binary does not exactly match. */
export async function assertSchemaCurrent(db: Kysely<DB>): Promise<void> {
  const version = await readSchemaVersion(db);
  if (version === null) {
    throw invariant('the Postgres store has no schema', "run 'mimir store upgrade' to create it");
  }
  if (version > SCHEMA_VERSION) {
    throw invariant(
      `the Postgres store schema is version ${String(version)}; this binary reads version ${String(SCHEMA_VERSION)}`,
      'upgrade the binary; a newer schema is never downgraded',
    );
  }
  if (version < SCHEMA_VERSION) {
    throw invariant(
      `the Postgres store schema is version ${String(version)}; this binary needs version ${String(SCHEMA_VERSION)}`,
      `run 'mimir store upgrade' on one machine; every binary must be at least version ${String(SCHEMA_VERSION)}`,
    );
  }
}

export type UpgradeReport = {
  /** The version the store was on; `0` when it carried no schema. */
  from: number;
  to: number;
  /** The migrations this run applied, in order. */
  applied: string[];
};

/** The migrations a store on `version` still needs, in order. */
function pendingFrom(version: number | null): Migration[] {
  return MIGRATIONS.filter((migration) => migration.version > (version ?? 0));
}

/**
 * Apply every pending migration, each in its own transaction under an advisory
 * lock so two machines upgrading at once serialize rather than interleave. The
 * version is re-read INSIDE the lock: the loser of the race must see the
 * winner's work and apply nothing, not re-run a migration that already landed.
 */
export async function upgradeSchema(db: Kysely<DB>): Promise<UpgradeReport> {
  const before = await readSchemaVersion(db);
  if (before !== null && before > SCHEMA_VERSION) {
    throw invariant(
      `the Postgres store schema is version ${String(before)}; this binary reads version ${String(SCHEMA_VERSION)}`,
      'upgrade the binary; a newer schema is never downgraded',
    );
  }
  const applied: string[] = [];
  for (const migration of pendingFrom(before)) {
    const ran = await db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(${UPGRADE_LOCK}::bigint)`.execute(tx);
      if (((await readSchemaVersion(tx)) ?? 0) >= migration.version) {
        return false;
      }
      await migration.up(tx);
      await tx
        .insertInto('schema_version')
        .values({ applied_at: now(), version: migration.version })
        .execute();
      return true;
    });
    if (ran) {
      applied.push(migration.name);
    }
  }
  return { applied, from: before ?? 0, to: (await readSchemaVersion(db)) ?? 0 };
}
