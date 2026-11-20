import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { createCommitGate, HELD } from './commit-gate';
import type { CommitGate } from './commit-gate';

/** One opening of a dialog. A commit belongs to the opening it started in, and only touches it. */
type Opening = { readonly id: number; readonly gate: CommitGate };

/** How a commit finished for the opening it started in: it returned nothing, or its promise resolved. */
export type Committed = 'returned' | 'resolved';

/** The work a commit runs. It must not reopen its own dialog before it returns. */
export type CommitWork = () => void | Promise<void>;

/**
 * A number that changes each time `open` turns true, already in the render
 * where it does. The one count of a dialog's openings: `useOpening` names its
 * opening by it, and a form keys its fields' state by it, so each opening
 * starts fresh even when its sheet stays mounted.
 */
export function useOpeningKey(open: boolean): number {
  const [seen, setSeen] = useState({ count: open ? 1 : 0, open });
  if (seen.open !== open) {
    setSeen({ count: open ? seen.count + 1 : seen.count, open });
  }
  return open && !seen.open ? seen.count + 1 : seen.count;
}

function createOpening(id: number): Opening {
  return { gate: createCommitGate(), id };
}

function restoreCommitFocus(button: HTMLButtonElement | null) {
  if (button?.isConnected !== true) {
    return;
  }
  const { activeElement, body } = button.ownerDocument;
  if (activeElement === null || activeElement === body || activeElement === button) {
    button.focus();
  }
}

/**
 * The commit state of a dialog, scoped to one opening, shared by Destructive
 * confirm and Reason. Each time `open` turns true the dialog starts a new
 * opening with its own commit gate and no busy commit, so a commit from an
 * earlier opening that never settled cannot lock, close, or free this one.
 *
 * `busy` is true while this opening's commit promise runs, or while the caller
 * says its own call is `pending`. When a busy period ends with the dialog open
 * (a refusal, however the caller reports it), restore focus dropped when the
 * pressed commit disabled. If `commitDisabled` still holds the button disabled,
 * restoration waits until it is enabled in the same opening. Closing or finding
 * focus on another control when the button enables discards the request. `key`
 * names the opening (`useOpeningKey`), for content that must remount with each one.
 */
export function useOpening(open: boolean, pending: boolean, commitDisabled = false) {
  // The opening advances while rendering the one where `open` turns true, so the render that
  // shows the dialog already holds it and every click on that render's buttons sees it.
  const id = useOpeningKey(open);
  const [shown, setShown] = useState(() => createOpening(id));
  let opening = shown;
  if (shown.id !== id) {
    opening = createOpening(id);
    setShown(opening);
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

  const ran = useRef<{ button: HTMLButtonElement | null; opening: Opening } | null>(null);
  const refocusIn = useRef<Opening | null>(null);
  useEffect(() => {
    if (!open) {
      ran.current = null;
      refocusIn.current = null;
      return;
    }
    if (busy) {
      refocusIn.current = opening;
      return;
    }
    if (refocusIn.current !== opening) {
      return;
    }
    const pressed = ran.current?.opening === opening ? ran.current.button : null;
    if (pressed?.isConnected === true && (commitDisabled || pressed.disabled)) {
      return;
    }
    refocusIn.current = null;
    restoreCommitFocus(pressed);
  }, [busy, commitDisabled, open, opening]);

  /**
   * Runs `work` from the `button` that was pressed, once at a time per opening.
   * `onCommitted` runs when it returns nothing or its promise resolves while
   * this opening is current. A throw or a rejection leaves the dialog open,
   * and restores dropped focus to `button`. The caller's call reports the failure.
   */
  async function commit(
    button: HTMLButtonElement | null,
    work: CommitWork,
    onCommitted: (how: Committed) => void,
  ): Promise<void> {
    const mine = opening;
    let result: void | Promise<void> | typeof HELD;
    try {
      result = mine.gate.run(work);
    } catch {
      restoreCommitFocus(button);
      return;
    }
    if (result === HELD) {
      return;
    }
    ran.current = { button, opening: mine };
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
