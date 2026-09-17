import { Kysely, PostgresDialect } from 'kysely';
import type { PoolConfig } from 'pg';
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

/**
 * How long a caller waits for a pooled connection before the request fails.
 *
 * `pg` waits forever by default, so an exhausted pool — or a server that stopped
 * answering — presents as a command that never returns and never says why. A
 * bounded wait turns both into an error the caller can report and the operator
 * can act on.
 */
export const CONNECTION_TIMEOUT_MS = 5000;

export type OpenOptions = {
  /** Build the pool from the config this module composed. Tests inject one to
   * hold on to the pool; production takes the default. */
  createPool?: (config: PoolConfig) => Pool;
  /** Where an idle-connection fault is reported. Defaults to stderr. */
  log?: (line: string) => void;
};

export function openPostgres(url: string, options: OpenOptions = {}): PostgresHandle {
  const createPool = options.createPool ?? ((config: PoolConfig) => new Pool(config));
  const log = options.log ?? ((line: string) => console.error(line));
  const pool = createPool({
    connectionString: url,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  // A pooled connection can die while it sits IDLE — the server restarts, an
  // idle-session timeout fires, the network drops — and `pg` reports that on the
  // pool rather than on any one query. An EventEmitter with no `error` listener
  // RETHROWS, so without this a fault the next query simply reconnects past
  // would instead take down `mimir serve` or the MCP session holding the store.
  pool.on('error', (error: Error) => {
    log(`the postgres store lost an idle connection: ${error.message}`);
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  // `destroy` ends the pool too, so there is one handle to release.
  return { close: () => db.destroy(), db };
}
