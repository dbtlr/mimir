import type { Kysely, Transaction } from 'kysely';

import type { MigrationStatements } from './migrations';
import type { DB, Executor, Stored } from './schema';

/**
 * The dialect seam of the shared SQL store (ADR 0032 Decision 2) — everything
 * the store's query code cannot say once for every database.
 *
 * The query code under `core/store-sql` is plain Kysely builder code; a dialect
 * supplies the transaction and retry policy, the schema-version probe and the
 * upgrade lock, the DDL, the few statements no portable form exists for, the
 * column shapes that differ by driver, and the reading of driver errors. The
 * connection itself is not here: a backend builds its `Kysely<DB>` and hands it
 * in beside its dialect.
 *
 * Named `StoreDialect` so it never reads as Kysely's own `Dialect`, which is
 * the driver plumbing one layer down.
 */
export type StoreDialect = {
  /** How the backend names itself in the schema gate's refusals ("the Postgres store …"). */
  label: string;

  /**
   * Run `fn` as one write transaction that either lands whole or not at all,
   * however many writers contend — replaying it, if the dialect's isolation
   * aborts rather than blocks. Behind `Store.transact` and every slice's write.
   */
  write: <T>(db: Kysely<DB>, fn: (tx: Transaction<DB>) => Promise<T>) => Promise<T>;

  /**
   * Run `fn` over one consistent snapshot: the bulk read is several queries the
   * core derives over as one projection, so no write may land between them.
   */
  snapshot: <T>(db: Kysely<DB>, fn: (tx: Transaction<DB>) => Promise<T>) => Promise<T>;

  /**
   * Check every deferred constraint now. An import preview rolls back instead
   * of committing, so this stands in for the COMMIT that would otherwise check
   * them (MMR-380).
   */
  checkDeferredConstraints: (tx: Transaction<DB>) => Promise<void>;

  /** Is this driver error a unique-key violation? */
  isUniqueViolation: (error: unknown) => boolean;

  /**
   * Does the store carry a `schema_version` table? Absence is PROBED, never
   * caught from a failed select (see `readSchemaVersion`).
   */
  hasSchemaVersionTable: (ex: Executor) => Promise<boolean>;

  /**
   * Run one migration step in a transaction that excludes every other upgrade
   * of the same store, so two processes upgrading at once serialize rather
   * than interleave.
   */
  upgrade: <T>(db: Kysely<DB>, fn: (tx: Transaction<DB>) => Promise<T>) => Promise<T>;

  /** Each migration's literal DDL in this dialect, by migration name. */
  migrations: MigrationStatements;

  /**
   * What the schema gate tells the operator to do about a store with no
   * schema, or one behind this binary — the explicit upgrade a shared store
   * needs, or nothing more than reopening a store that migrates on open.
   */
  schemaRemedy: { missing: string; behind: string };

  /**
   * The bind parameters one statement may carry. Batched inserts and `IN`
   * lists are chunked under it (see `./batch`).
   */
  maxParameters: number;

  /** The column shapes that differ by driver (see {@link Stored}). */
  codecs: ValueCodecs;
};

/** One column shape: the value the store speaks, and the form the driver stores. */
export type Codec<T> = {
  encode: (value: T) => Stored<T>;
  decode: (stored: Stored<T>) => T;
};

/**
 * The codecs for every column whose JS shape differs by driver. A dialect
 * whose driver already speaks the store's shape implements them as identity.
 */
export type ValueCodecs = {
  /** A boolean column (`next_present`, `open_ended`). */
  bool: Codec<boolean>;
  /** A list-of-text column (`seed.spawned`, `scratchpad.anchors`). */
  list: Codec<string[]>;
  /** A JSON document column (`handles`, `journal`, `agenda`). */
  json: {
    encode: <T>(value: T) => Stored<T>;
    decode: <T>(stored: Stored<T>) => T;
  };
};
