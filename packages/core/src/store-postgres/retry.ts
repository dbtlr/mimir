import { setTimeout as delay } from 'node:timers/promises';

import { conflict } from '../errors';

/**
 * The serialization-failure retry loop behind `Store.transact` (ADR 0030).
 *
 * A SERIALIZABLE transaction is allowed to abort rather than block: PostgreSQL
 * detects the dangerous read/write dependency at commit time and raises
 * SQLSTATE 40001, and a deadlock raises 40P01. Both mean "nothing was written,
 * run it again" — so the whole closure is replayed rather than any single
 * statement, which is what makes the isolation level usable without every verb
 * knowing about it.
 *
 * Bounded and jittered: an unbounded retry turns a genuine hot spot into a
 * livelock, and an unjittered one keeps two writers colliding in lockstep.
 */

/** SQLSTATEs that mean the transaction may be replayed as-is. */
const RETRYABLE = new Set(['40001', '40P01']);

/**
 * How many times the whole closure is replayed before the store gives up.
 *
 * Sized against real contention, not a round number: ten agents creating into
 * one project all serialize on that project's counter row, and a five-attempt
 * budget ran out on roughly one such burst in three (MMR-379). Ten attempts
 * with a 1 s ceiling covers the burst; past that the store is genuinely
 * oversubscribed and saying so beats retrying forever.
 */
const MAX_ATTEMPTS = 10;

export type BackoffSettings = {
  /** The first sleep, doubling per attempt. */
  baseMs: number;
  /** The ceiling the doubling stops at. */
  capMs: number;
};

export const DEFAULT_BACKOFF: BackoffSettings = { baseMs: 25, capMs: 1000 };

/** Is this a PostgreSQL serialization failure or deadlock — a replayable abort? */
export function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code: unknown = error.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

/**
 * Sleep for a jittered slice of this attempt's backoff window.
 *
 * Half the window is fixed and half is random. Pure random jitter over the whole
 * window draws a near-zero sleep often enough to matter: the loser of a contended
 * row then retries straight back into the winner's next transaction, and a
 * bounded budget can run out on a hot spot two writers would otherwise share
 * comfortably. The fixed half guarantees the retry lands after the collision it
 * lost to; the random half keeps two writers from colliding in lockstep.
 */
async function backoff(attempt: number, settings: BackoffSettings): Promise<void> {
  const window = Math.min(settings.baseMs * 2 ** attempt, settings.capMs);
  if (window <= 0) {
    return;
  }
  await delay(window / 2 + (Math.random() * window) / 2);
}

/**
 * Run `fn` until it commits, replaying it on a serialization failure. Any other
 * failure propagates unchanged and immediately — a constraint violation or a
 * domain refusal is deterministic, and replaying it would only hide it behind a
 * retry count.
 */
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  settings: BackoffSettings = DEFAULT_BACKOFF,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isSerializationFailure(error)) {
        throw error;
      }
      await backoff(attempt, settings);
    }
  }
  // A DOMAIN refusal, not an internal error: nothing is broken and nothing is
  // half-written — too many writers wanted the same rows at once, and the
  // caller's move is to run the command again. `invariant` would read as a bug
  // in mimir and send the operator looking for one.
  throw conflict(
    `the store is busy: ${String(MAX_ATTEMPTS)} concurrent writers kept conflicting on this change`,
    'retry the command; if this persists, fewer agents should write this board at once',
  );
}
