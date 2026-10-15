/**
 * Migration `0002_grooming` (ADR 0033) — adds the task-only `grooming` column
 * to `node`. The vocabulary is written as frozen literals, not read from the
 * contract: a migration is a historical fact, so a later change to the live
 * enum can never alter what this one means.
 *
 * Existing rows read NULL until the backfill. Only tasks are backfilled, so a
 * container keeps NULL exactly as it does for `hold`.
 */
export const statements: readonly string[] = [
  `ALTER TABLE node ADD COLUMN grooming text
     CHECK (grooming IN ('not_groomed', 'needs_answers', 'groomed'))`,
  `UPDATE node SET grooming = 'not_groomed' WHERE type = 'task'`,
];
