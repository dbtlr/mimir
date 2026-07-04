/**
 * The core — transport-agnostic, storage-committed domain logic. Public surface
 * the intent layer (Phase 2) renders through the transports: create + mutation
 * verbs, the live derivation (status word, rollup, predicates), rank ops, id
 * rendering/resolution, and the error vocabulary. Imports `db` + `contract`;
 * never a transport.
 */
export type { Db, Tx } from './context';
export * from './create';
export * from './mutations';
export * from './derive';
export * from './predicates';
export * from './rank';
export * from './ids';
export * from './lookup';
export * from './query';
export type * from './store';
export * from './store-sqlite';
export * from './resource';
export * from './errors';
export * from './status';
export * from './intent';
export * from './format';
export { now } from './time';
export * from './artifacts';
export * from './body-sections';
