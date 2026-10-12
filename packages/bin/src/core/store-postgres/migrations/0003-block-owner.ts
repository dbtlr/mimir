/**
 * Migration `0003_block_owner` (ADR 0001, MMR-438) — adds the nullable
 * `block_owner` column to `node`: who can clear a `blocked` hold. The vocabulary
 * is written as frozen literals, not read from the contract: a migration is a
 * historical fact, so a later change to the live enum can never alter what this
 * one means.
 *
 * Existing rows read NULL until the backfill. Only blocked tasks are backfilled,
 * by the rule the `block` verb defaults with: a task that names an upstream seed
 * asked another board for help (`others`), anything else waits on the operator
 * (`you`). Parked and unheld tasks stay NULL, because the owner is meaningful
 * only while the hold is `blocked`.
 */
export const statements: readonly string[] = [
  `ALTER TABLE node ADD COLUMN block_owner text
     CHECK (block_owner IN ('you', 'others'))`,
  `UPDATE node
     SET block_owner = CASE WHEN upstream IS NOT NULL THEN 'others' ELSE 'you' END
     WHERE hold = 'blocked'`,
];
