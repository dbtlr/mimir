/**
 * The `@mimir/core/testing` entry: fixtures the transports' tests build on.
 * Kept off the main entry so the shipped binary never bundles them (the
 * Postgres fixtures pull in PGlite).
 */
export * from './conformance';
export * from './errors';
export * from './store';
export { createPgliteDialect } from '../store-postgres/pglite';
export * from '../store-postgres/testing';
export * from '../store-sqlite/testing';
export { protocolCandidate } from '../installation/test-fixtures';
