/**
 * The Postgres store backend (ADR 0030) — the public surface the composition
 * root builds a `Store` from. Everything below is an implementation detail of
 * this directory; a caller outside it names only what this barrel exports.
 */
export type { PostgresHandle } from './client';
export { openPostgres } from './client';
export type { UpgradeReport } from './migrator';
export { assertSchemaCurrent, readSchemaVersion, SCHEMA_VERSION, upgradeSchema } from './migrator';
export { createPgliteDialect } from './pglite';
export type { DB } from './schema';
export { createPostgresStore } from './store';
export type { PostgresTestStore } from './testing';
export { createPgliteTestStore } from './testing';
