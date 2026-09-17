import { expect, test } from 'bun:test';

import { MimirError } from '../errors';
import { isSerializationFailure, withSerializableRetry } from './retry';

/** A PostgreSQL error as the drivers surface it: a SQLSTATE on `code`. */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres said ${code}`), { code });
}

const NO_BACKOFF = { baseMs: 0, capMs: 0 };

test('serialization_failure and deadlock_detected are the retryable SQLSTATEs', () => {
  expect(isSerializationFailure(pgError('40001'))).toBe(true);
  expect(isSerializationFailure(pgError('40P01'))).toBe(true);
  expect(isSerializationFailure(pgError('23505'))).toBe(false);
  expect(isSerializationFailure(new Error('no code at all'))).toBe(false);
});

test('a closure that serializes on its third attempt returns its value', async () => {
  let attempts = 0;
  const result = await withSerializableRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      throw pgError('40001');
    }
    return Promise.resolve('landed');
  }, NO_BACKOFF);
  expect(result).toBe('landed');
  expect(attempts).toBe(3);
});

test('a closure that never serializes exhausts its retries and refuses as a conflict', async () => {
  // Ordinary contention is a DOMAIN refusal, not an internal error: nothing is
  // broken, too many writers wanted the same row at once, and the caller's move
  // is to run the command again.
  let attempts = 0;
  const failure = withSerializableRetry(() => {
    attempts += 1;
    throw pgError('40001');
  }, NO_BACKOFF);
  const error = await failure.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MimirError);
  expect((error as MimirError).code).toBe('conflict');
  expect((error as MimirError).message).toBe(
    'the store is busy: 10 concurrent writers kept conflicting on this change',
  );
  expect((error as MimirError).hint).toBe(
    'retry the command; if this persists, fewer agents should write this board at once',
  );
  expect(attempts).toBe(10);
});

test('a retry never lands sooner than half its backoff window', async () => {
  // The floor is the point of the jitter split: a retry that can sleep ~0 ms
  // lands straight back on the collision it just lost, and a bounded budget
  // runs out on a hot spot two writers would otherwise share.
  let attempts = 0;
  const started = performance.now();
  await withSerializableRetry(
    () => {
      attempts += 1;
      if (attempts < 2) {
        throw pgError('40001');
      }
      return Promise.resolve('landed');
    },
    { baseMs: 100, capMs: 100 },
  );
  expect(performance.now() - started).toBeGreaterThanOrEqual(50);
});

test('a non-serialization failure propagates unchanged on the first attempt', async () => {
  let attempts = 0;
  const failure = withSerializableRetry(() => {
    attempts += 1;
    throw pgError('23505');
  }, NO_BACKOFF);
  const error = await failure.catch((e: unknown) => e);
  expect((error as Error).message).toBe('postgres said 23505');
  expect(attempts).toBe(1);
});
