import type { Kysely, Transaction } from 'kysely';

import { withSerializableRetry } from './retry';
import type { DB } from './schema';

/**
 * The two transaction shapes the backend runs in, in one place so every slice
 * opens its scope the same way.
 *
 * A WRITE is SERIALIZABLE and replayed on a serialization failure: the seam
 * promises that a `transact` closure either lands whole or not at all, and
 * under a shared store the only way to keep that promise without a lock
 * protocol is the strictest isolation plus a retry (ADR 0030).
 *
 * A bulk READ is REPEATABLE READ, which is enough: the projection must be
 * self-consistent across its several queries, and it writes nothing that could
 * form the dangerous dependency SERIALIZABLE exists to catch.
 */

/** Either a pooled handle or an open transaction — every read takes both. */
export type Executor = Kysely<DB> | Transaction<DB>;

/** Run `fn` in one SERIALIZABLE transaction, replaying it on a 40001/40P01. */
export function serializable<T>(
  db: Kysely<DB>,
  fn: (tx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return withSerializableRetry(() =>
    db.transaction().setIsolationLevel('serializable').execute(fn),
  );
}

/** Run `fn` over one consistent snapshot of the store. */
export function snapshotRead<T>(
  db: Kysely<DB>,
  fn: (tx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().setIsolationLevel('repeatable read').execute(fn);
}
