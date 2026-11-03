/**
 * Migration `0011_terminal_hold` (MMR-616) — a terminal task has no hold.
 * Binaries before this one left a `blocked` or `parked` hold, its reason, and
 * its owner on a task that `done` or `abandon` closed, so the task still read
 * as held in raw filters and a reopen revived the stale hold. This clears those
 * fields on every done or abandoned task. Data only: the hold's history stays
 * on its transition-log row, and `updated_at` is left alone because no one
 * edited the task. The lifecycle words are frozen literals: a migration is a
 * historical fact.
 */
export const statements: readonly string[] = [
  `UPDATE node
     SET hold = 'none', hold_reason = NULL, block_owner = NULL
     WHERE lifecycle IN ('done', 'abandoned')
       AND (hold <> 'none' OR hold_reason IS NOT NULL OR block_owner IS NOT NULL)`,
];
