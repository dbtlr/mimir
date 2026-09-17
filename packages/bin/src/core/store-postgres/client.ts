import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from './schema';

/**
 * The real-Postgres connection (ADR 0030) — a `pg` pool behind Kysely's
 * PostgreSQL dialect.
 *
 * The URL comes from `[store] url` in the global config and nowhere else: a
 * shared store is an operator decision recorded in a file, not an ambient
 * environment variable that makes the same command mean two things on two
 * machines.
 */

export type PostgresHandle = {
  db: Kysely<DB>;
  close: () => Promise<void>;
};

export function openPostgres(url: string): PostgresHandle {
  const pool = new Pool({ connectionString: url });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  // `destroy` ends the pool too, so there is one handle to release.
  return { close: () => db.destroy(), db };
}
