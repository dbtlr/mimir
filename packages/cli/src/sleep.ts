/**
 * A wait that ends when the run is cancelled: Ctrl-C during a long poll must
 * not leave the process sleeping out its interval.
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Resolve after `ms`; if `signal` aborts first, throw its reason so the run reads as cancelled. */
export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}
