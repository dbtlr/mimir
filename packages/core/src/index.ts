/**
 * The core — transport-agnostic, storage-committed domain logic. The one public
 * entry of `@mimir/core`: create + mutation verbs, the live derivation (status
 * word, rollup, predicates), rank ops, id rendering/resolution, and the error
 * vocabulary, plus the store backends, the doctor, the installation record, and
 * the runtime config the transports compose. Imports `contract` and `helpers`;
 * never a transport. Test fixtures live behind `@mimir/core/testing`.
 */
export * from './create';
export * from './engine';
export * from './field-spec';
export * from './ops';
export * from './mutations';
export * from './derive';
export * from './predicates';
export * from './rank';
export * from './ids';
export * from './resolve-set';
export * from './query';
export * from './dates';
export type * from './store';
export * from './export';
export { projectOnlyRefusal } from './project-only';
export * from './resource';
export * from './errors';
export * from './remote';
export * from './status';
export * from './intent';
export { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchRecords } from './search/intent';
export type { SearchOptions } from './search/intent';
export * from './format';
export { now } from './time';
export type * from './artifacts';
export * from './seeds';
export * from './scratchpads';
export type * from './body-sections';
export type * from './transitions';
export type { Node } from './model';
export * from './health';
export type { ArtifactStore } from './artifacts/store';
export type { ScratchpadStore } from './scratchpads/store';
export * from './env';
export * from './config';
export { acceptedHosts, hostnameOf, isHostName, normalizeServeUrl } from './address';
export type { ServeConfig } from './address';
export { assertUsableStoreConfig, buildStore } from './store-backend';
export type { BuiltStore, StoreOverride } from './store-backend';
export { buildSqliteStore, openInstallationSqlite } from './store-sqlite-backend';
export { assertPostgresAccess } from './postgres-access';
export { postgresUrlMissing } from './store-postgres-backend';
export { sandboxAuthorityFromEnvironment } from './sandbox-authority';
export { findingLine, isUnscoped } from './doctor/contract';
export type {
  DoctorBackend,
  DoctorDiagnosis,
  DoctorFinding,
  DoctorScopeMatch,
} from './doctor/contract';
export { emptyDoctorFacet } from './doctor/facet';
export type { DoctorFacet } from './doctor/facet';
export { warnConfigPermissions, withConfigDoctor } from './doctor/config-permissions';
export { SQLITE_FILE } from './store-sqlite/client';
export { openSqlite } from './store-sqlite/index';
export type { SqliteHandle } from './store-sqlite/index';
export { openPostgres, upgradeSchema } from './store-postgres/index';
export type { DB, PostgresHandle, UpgradeReport } from './store-postgres/index';
export { SCHEMA_VERSION } from './store-sql/migrator';
export { readInstallationAt, registerInstallation } from './installation';
export { runInstallationCommand } from './installation/command';
export {
  INSTALLATION_PROTOCOL_RESPONSE,
  requireInstallationProtocol,
} from './installation/protocol';
