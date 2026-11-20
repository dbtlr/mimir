import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { createCommitGate, HELD } from './commit-gate';
import type { CommitGate } from './commit-gate';

/** One opening of a dialog. A commit belongs to the opening it started in, and only touches it. */
type Opening = { readonly id: number; readonly gate: CommitGate };

/** How a commit finished for the opening it started in: it returned nothing, or its promise resolved. */
export type Committed = 'returned' | 'resolved';

/** The work a commit runs. It must not reopen its own dialog before it returns. */
export type CommitWork = () => void | Promise<void>;

function createOpening(id: number): Opening {
  return { gate: createCommitGate(), id };
}

/**
 * The commit state of a dialog, scoped to one opening, shared by Destructive
 * confirm and Reason. Each time `open` turns true the dialog starts a new
 * opening with its own commit gate and no busy commit, so a commit from an
 * earlier opening that never settled cannot lock, close, or free this one.
 *
 * `busy` is true while this opening's commit promise runs, or while the caller
 * says its own call is `pending`. When a busy period ends with the dialog open
 * (a refusal, however the caller reports it), focus returns to the commit that
 * ran, since a browser drops focus when the focused commit disables. `key`
 * names the opening, for content that must remount with each one.
 */
export function useOpening(open: boolean, pending: boolean) {
  // The opening advances while rendering the one where `open` turns true, so the render that
  // shows the dialog already holds it and every click on that render's buttons sees it.
  const [seen, setSeen] = useState(() => ({ open, opening: createOpening(0) }));
  let opening = seen.opening;
  if (seen.open !== open) {
    if (open) {
      opening = createOpening(seen.opening.id + 1);
    }
    setSeen({ open, opening });
  }
  const [running, setRunning] = useState<Opening | null>(null);
  const busy = pending || running === opening;
  // Read by a commit after it awaits, to tell whether its opening is still the current one. It
  // advances in a layout effect, in the same task as the DOM commit that reopens the dialog, so
  // neither a click nor a settle can see it stale. (A passive effect could, if one landed before
  // the effect flushed; React 19 under jsdom flushes first, so no test here can show the gap.)
  // The gate and `busy` need no ref: a click runs the `commit` of the render it pressed.
  const current = useRef(opening);
  useLayoutEffect(() => {
    current.current = opening;
  }, [opening]);

  const ran = useRef<HTMLElement | null>(null);
  const busyIn = useRef<Opening | null>(null);
  useEffect(() => {
    const settled = !busy && busyIn.current === opening;
    busyIn.current = busy ? opening : null;
    const pressed = ran.current;
    if (settled && open && pressed?.isConnected === true) {
      pressed.focus();
    }
  }, [busy, open, opening]);

  /**
   * Runs `work` from the `button` that was pressed, once at a time per opening.
   * `onCommitted` runs when it returns nothing or its promise resolves while
   * this opening is current. A throw or a rejection leaves the dialog open,
   * with focus back on `button`; the caller's call reports the failure.
   */
  async function commit(
    button: HTMLElement | null,
    work: CommitWork,
    onCommitted: (how: Committed) => void,
  ): Promise<void> {
    const mine = opening;
    let result: void | Promise<void> | typeof HELD;
    try {
      result = mine.gate.run(work);
    } catch {
      button?.focus();
      return;
    }
    if (result === HELD) {
      return;
    }
    ran.current = button;
    if (!(result instanceof Promise)) {
      onCommitted('returned');
      return;
    }
    setRunning(mine);
    try {
      await result;
      if (current.current === mine) {
        onCommitted('resolved');
      }
    } catch {
      // The caller's call reports the failure; the dialog stays for another attempt.
    } finally {
      setRunning((held) => (held === mine ? null : held));
    }
  }

  return { busy, commit, key: opening.id };
}
