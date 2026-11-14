/** Tasks alone carry the delivery reference (ADR 0042). */
export const statements = [
  "ALTER TABLE node ADD COLUMN delivery TEXT REFERENCES delivery(id) CHECK (delivery IS NULL OR type = 'task')",
] as const;
