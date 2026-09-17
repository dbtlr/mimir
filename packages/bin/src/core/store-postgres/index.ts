/**
 * The Postgres store backend (ADR 0030) — the public surface the composition
 * root builds a `Store` from. Everything below is an implementation detail of
 * this directory; a caller outside it names only what this barrel exports.
 *
 * The test fixtures are deliberately NOT here. `./testing` and `./pglite` pull
 * in `@electric-sql/pglite`, a WebAssembly PostgreSQL engine; re-exporting them
 * from the barrel put that engine into the compiled binary, because a value
 * re-export is a value import no bundler can shake out. Tests import those two
 * modules by path.
 */
export type { PostgresHandle } from './client';
export { openPostgres } from './client';
export type { UpgradeReport } from './migrator';
export { assertSchemaCurrent, readSchemaVersion, SCHEMA_VERSION, upgradeSchema } from './migrator';
export type { DB } from './schema';
export { createPostgresStore } from './store';
