import { expect, test } from 'bun:test';

import { abortableSleep } from './sleep';

/** What a promise rejects with, or a marker when it resolves. */
async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (reason) {
    return reason;
  }
}

test('the sleep resolves after its time when nothing aborts', async () => {
  expect(await reasonOf(abortableSleep(5, new AbortController().signal))).toBe('resolved');
});

test('an abort ends a long sleep at once, with the signal reason', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const sleeping = reasonOf(abortableSleep(60_000, controller.signal));
  controller.abort('stop');
  expect(await sleeping).toBe('stop');
  expect(performance.now() - started).toBeLessThan(1000);
});

test('a signal already aborted refuses before sleeping', async () => {
  expect(await reasonOf(abortableSleep(60_000, AbortSignal.abort('already')))).toBe('already');
});
