/**
 * The Kysely database interface — the typed shape of every table.
 *
 * Empty during Phase 0 (scaffold): the first real schema arrives in Phase 1 as
 * `migrations/0001_init`, at which point this interface gains the `task`,
 * `node`, `transition_log`, `tag`, `artifact`, etc. table types (mirroring
 * `notes/mimir-schema-reference.md`). Kept as the single source of DB types so
 * `core` queries against a precise `Kysely<DB>`.
 */
export type DB = Record<string, never>;
