import type { Lifecycle } from '@mimir/contract';
import { isTerminalLifecycle } from '@mimir/contract';

/**
 * The hold fields of an unheld task (ADR 0001): no hold, no reason, no owner.
 * Every path that releases a hold writes exactly these: `unblock` and `unpark`,
 * the terminal verbs `done` and `abandon` (a terminal task has no hold,
 * MMR-616), `reopen`'s repair, and the transfer import.
 */
export const RELEASED_HOLD = { block_owner: null, hold: 'none', hold_reason: null } as const;

/** Whether a row's lifecycle forbids a hold: a done or abandoned task carries none. */
export function holdsNoHold(lifecycle: Lifecycle | null): boolean {
  return lifecycle !== null && isTerminalLifecycle(lifecycle);
}
