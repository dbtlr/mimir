import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "@meck93/kysely-bun-sqlite";
import type { DB } from "./schema";

/**
 * Connection pragmas applied to every database we open.
 *
 * - `journal_mode = WAL` — concurrent readers alongside the single writer
 *   (a no-op for `:memory:`, harmless to set).
 * - `busy_timeout` — wait rather than fail when another writer (or the
 *   migration lock) holds the write lock; the cheap half of "under a lock".
 * - `foreign_keys = ON` — SQLite defaults this off per-connection.
 */
const PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA busy_timeout = 5000;",
  "PRAGMA foreign_keys = ON;",
] as const;

/**
 * Open a Mimir database at `path` (default in-memory) as a typed Kysely
 * instance. The core is storage-committed: it talks to this `Kysely<DB>`
 * directly — there is no repository port to swap.
 */
export function createDb(path = ":memory:"): Kysely<DB> {
  const sqlite = new Database(path);
  for (const pragma of PRAGMAS) {
    sqlite.run(pragma);
  }
  return new Kysely<DB>({ dialect: new BunSqliteDialect({ database: sqlite }) });
}
