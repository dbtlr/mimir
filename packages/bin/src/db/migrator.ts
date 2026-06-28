import { Migrator } from 'kysely';
import type {
  Kysely,
  Migration,
  MigrationProvider,
  MigrationResultSet,
  MigrationInfo,
} from 'kysely';

import { migrations } from './migrations';
import type { DB } from './schema';

/**
 * Serves the statically-bundled migration set to Kysely's Migrator. No
 * filesystem access — the binary carries its own migrations.
 */
class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  }
}

function migratorFor(db: Kysely<DB>): Migrator {
  return new Migrator({ db, provider: new StaticMigrationProvider() });
}

/**
 * Apply every pending migration, forward-only. Kysely runs these under its
 * migration-lock table; combined with the connection's `busy_timeout` and
 * SQLite's single-writer guarantee, concurrent starters serialize rather than
 * racing — "auto-applied on startup under a lock".
 */
export function migrateToLatest(db: Kysely<DB>): Promise<MigrationResultSet> {
  return migratorFor(db).migrateToLatest();
}

/** The full migration list with each entry's executed/pending state. */
export function migrationStatus(db: Kysely<DB>): Promise<readonly MigrationInfo[]> {
  return migratorFor(db).getMigrations();
}
