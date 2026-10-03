/**
 * The forward-only migration list (ADR 0030). Static and ordered: a binary
 * carries its migrations in its own code, so there is no filesystem scan, no
 * ordering by filename, and no way for two binaries to disagree about what
 * version N means.
 *
 * `version` is the schema version a migration LANDS the store on, so the last
 * entry's version is `SCHEMA_VERSION`. Append, never edit — a migration that
 * has run on any store is a historical fact.
 *
 * The list is shared; the DDL is not. Each dialect supplies every migration's
 * literal statements by name ({@link MigrationStatements}), so appending a
 * migration here without writing it for every dialect does not compile.
 */
export const MIGRATIONS = [{ name: '0001_init', version: 1 }] as const;

export type Migration = (typeof MIGRATIONS)[number];

/** Every migration's literal DDL in one dialect, keyed by migration name. */
export type MigrationStatements = Readonly<Record<Migration['name'], readonly string[]>>;
