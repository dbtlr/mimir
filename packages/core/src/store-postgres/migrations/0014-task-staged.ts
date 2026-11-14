/** Admit `staged` tasks (MMR-675) while preserving the existing node records. */
export const statements: readonly string[] = [
  `ALTER TABLE node DROP CONSTRAINT node_lifecycle_check`,
  `ALTER TABLE node ADD CONSTRAINT node_lifecycle_check
     CHECK (lifecycle IN ('todo', 'queued', 'in_progress', 'under_review', 'staged', 'done', 'abandoned'))`,
];
