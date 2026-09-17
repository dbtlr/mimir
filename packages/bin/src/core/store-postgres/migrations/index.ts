import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { DB } from '../schema';
import { statements as init } from './0001-init';

/**
 * The forward-only migration list (ADR 0030). Static and ordered: a binary
 * carries its migrations in its own code, so there is no filesystem scan, no
 * ordering by filename, and no way for two binaries to disagree about what
 * version N means.
 *
 * `version` is the schema version a migration LANDS the store on, so the last
 * entry's version is `SCHEMA_VERSION`. Append, never edit — a migration that
 * has run on any store is a historical fact.
 */
export type Migration = {
  version: number;
  name: string;
  up: (db: Kysely<DB>) => Promise<void>;
};

/** Run a migration's literal DDL, one statement at a time. */
function runStatements(statements: readonly string[]): (db: Kysely<DB>) => Promise<void> {
  return async (db) => {
    for (const statement of statements) {
      await sql.raw(statement).execute(db);
    }
  };
}

export const MIGRATIONS: readonly Migration[] = [
  { name: '0001_init', up: runStatements(init), version: 1 },
];
