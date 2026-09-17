import { setTimeout as delay } from 'node:timers/promises';

import { invariant } from '../errors';

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

const MAX_ATTEMPTS = 5;

export type BackoffSettings = {
  /** The first sleep, doubling per attempt. */
  baseMs: number;
  /** The ceiling the doubling stops at. */
  capMs: number;
};

export const DEFAULT_BACKOFF: BackoffSettings = { baseMs: 25, capMs: 400 };

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
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isSerializationFailure(error)) {
        throw error;
      }
      lastError = error;
      await backoff(attempt, settings);
    }
  }
  throw invariant(
    'the store write path exhausted its serialization retries',
    lastError instanceof Error ? lastError.message : undefined,
  );
}
