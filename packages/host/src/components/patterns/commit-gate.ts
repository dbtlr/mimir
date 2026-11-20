import { useCallback, useRef } from 'react';

/** What `run` returns when the gate is closed and the work did not run. */
export const HELD = Symbol('held');

/** Runs `release` once `result` settles, however it settles; the caller handles the rejection. */
async function settle(result: Promise<unknown>, release: () => void): Promise<void> {
  try {
    await result;
  } catch {
    // The commit's own caller reports the failure.
  } finally {
    release();
  }
}

/**
 * A synchronous gate for one commit at a time, shared by Destructive confirm
 * and Reason. React state (`busy`) lags a click, so two clicks in one browser
 * task would both pass it; this flag closes on the first. It reopens when a
 * returned promise settles, or, for a commit that returns nothing, once the
 * render that reflects the caller's own pending or closed state has run (a
 * microtask later). A synchronous throw reopens it and rethrows.
 */
export function useCommitGate() {
  const held = useRef(false);
  return useCallback(<T>(work: () => T): T | typeof HELD => {
    if (held.current) {
      return HELD;
    }
    held.current = true;
    let result: T;
    try {
      result = work();
    } catch (error) {
      held.current = false;
      throw error;
    }
    const release = () => {
      held.current = false;
    };
    if (result instanceof Promise) {
      void settle(result, release);
    } else {
      queueMicrotask(release);
    }
    return result;
  }, []);
}
