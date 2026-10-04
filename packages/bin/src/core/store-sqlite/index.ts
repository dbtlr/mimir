/**
 * The SQLite store backend (ADR 0032) — the local tier's public surface. The
 * query code is the shared SQL store under `core/store-sql`; this directory is
 * its SQLite dialect and connection.
 */
export type { SqliteHandle } from './client';
export { openExistingSqlite, openSqlite, SQLITE_FILE } from './client';
export { createSqliteStore, readSchemaVersion, sqliteDialect, upgradeSchema } from './dialect';
