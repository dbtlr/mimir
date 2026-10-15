/**
 * Migration `0004_seed_parked` (MMR-473) — widens the `seed.lifecycle` check to
 * admit `parked`, the deliberate "later" for an untriaged seed. The vocabulary is
 * written as frozen literals, not read from the contract: a migration is a
 * historical fact, so a later change to the live enum can never alter what this
 * one means.
 *
 * Postgres names an inline column check `<table>_<column>_check`, so the old
 * constraint is dropped by that name and re-added under it.
 */
export const statements: readonly string[] = [
  `ALTER TABLE seed DROP CONSTRAINT seed_lifecycle_check`,
  `ALTER TABLE seed ADD CONSTRAINT seed_lifecycle_check
     CHECK (lifecycle IN ('new', 'parked', 'promoted', 'resolved', 'rejected'))`,
];
