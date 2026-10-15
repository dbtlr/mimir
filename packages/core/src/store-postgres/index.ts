/**
 * The Postgres store backend (ADR 0030) — the public surface the composition
 * root builds a `Store` from. The query code is the shared SQL store under
 * `core/store-sql` (ADR 0032); this directory is its Postgres dialect and
 * connection, and a caller outside it names only what this barrel exports.
 *
 * The test fixtures are deliberately NOT here. `./testing` and `./pglite` pull
 * in `@electric-sql/pglite`, a WebAssembly PostgreSQL engine; re-exporting them
 * from the barrel put that engine into the compiled binary, because a value
 * re-export is a value import no bundler can shake out. Tests import those two
 * modules by path.
 */
export type { UpgradeReport } from '../store-sql/migrator';
export { SCHEMA_VERSION } from '../store-sql/migrator';
export type { DB } from '../store-sql/schema';
export type { PostgresHandle } from './client';
export { openPostgres } from './client';
export {
  assertSchemaCurrent,
  createPostgresStore,
  postgresDialect,
  readSchemaVersion,
  upgradeSchema,
} from './dialect';
