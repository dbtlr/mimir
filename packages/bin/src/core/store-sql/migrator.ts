import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { invariant } from '../errors';
import { now } from '../time';
import type { StoreDialect } from './dialect';
import type { Migration } from './migrations';
import { MIGRATIONS } from './migrations';
import type { DB, Executor } from './schema';

/**
 * The schema gate (ADR 0030). A store shared by several machines runs one
 * binary per machine, so "which schema is this?" is a question every
 * connection must answer before it reads a row.
 *
 * The gate refuses a schema newer than this binary understands (it would
 * misread columns it does not know about) and an older one (it would write
 * columns the other binaries cannot read). `upgradeSchema` is the one act that
 * moves the schema. WHEN it runs is the backend's posture, not this module's:
 * on Postgres a binary NEVER migrates implicitly, and `mimir store upgrade` is
 * the explicit act, run once on one machine after every binary is new enough to
 * live with the result.
 */

/** The schema version this binary reads and writes. */
export const SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * The schema version stored in the database, or `null` when the store carries
 * no schema at all.
 *
 * Absence is PROBED, never caught from a failed select. Inside a transaction an
 * undefined-table error aborts the whole scope, and the upgrade reads the
 * version inside the transaction that is about to create the table — so a catch
 * here would poison the very migration it guards.
 */
export async function readSchemaVersion(
  ex: Executor,
  dialect: StoreDialect,
): Promise<number | null> {
  if (!(await dialect.hasSchemaVersionTable(ex))) {
    return null;
  }
  const row = await ex
    .selectFrom('schema_version')
    .select((eb) => eb.fn.max('version').as('version'))
    .executeTakeFirst();
  return row?.version ?? null;
}

/** Refuse to use a store whose schema this binary does not exactly match. */
export async function assertSchemaCurrent(db: Kysely<DB>, dialect: StoreDialect): Promise<void> {
  const version = await readSchemaVersion(db, dialect);
  if (version === null) {
    throw invariant(`the ${dialect.label} store has no schema`, dialect.schemaRemedy.missing);
  }
  if (version > SCHEMA_VERSION) {
    throw invariant(
      `the ${dialect.label} store schema is version ${String(version)}; this binary reads version ${String(SCHEMA_VERSION)}`,
      'upgrade the binary; a newer schema is never downgraded',
    );
  }
  if (version < SCHEMA_VERSION) {
    throw invariant(
      `the ${dialect.label} store schema is version ${String(version)}; this binary needs version ${String(SCHEMA_VERSION)}`,
      dialect.schemaRemedy.behind,
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

/** Run one migration's literal DDL in `dialect`, one statement at a time. */
async function runMigration(
  ex: Executor,
  dialect: StoreDialect,
  migration: Migration,
): Promise<void> {
  for (const statement of dialect.migrations[migration.name]) {
    await sql.raw(statement).execute(ex);
  }
}

/**
 * Apply every pending migration, each in its own upgrade transaction (see
 * {@link StoreDialect.upgrade}) so two machines upgrading at once serialize
 * rather than interleave. The version is re-read INSIDE that transaction: the
 * loser of the race must see the winner's work and apply nothing, not re-run a
 * migration that already landed.
 */
export async function upgradeSchema(db: Kysely<DB>, dialect: StoreDialect): Promise<UpgradeReport> {
  const before = await readSchemaVersion(db, dialect);
  if (before !== null && before > SCHEMA_VERSION) {
    throw invariant(
      `the ${dialect.label} store schema is version ${String(before)}; this binary reads version ${String(SCHEMA_VERSION)}`,
      'upgrade the binary; a newer schema is never downgraded',
    );
  }
  const applied: string[] = [];
  for (const migration of pendingFrom(before)) {
    const ran = await dialect.upgrade(db, async (tx) => {
      if (((await readSchemaVersion(tx, dialect)) ?? 0) >= migration.version) {
        return false;
      }
      await runMigration(tx, dialect, migration);
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
  return { applied, from: before ?? 0, to: (await readSchemaVersion(db, dialect)) ?? 0 };
}
