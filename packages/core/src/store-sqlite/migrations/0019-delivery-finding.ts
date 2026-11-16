/**
 * A delivery's known limitations and declined findings, numbered within their
 * delivery across both kinds (ADR 0042, MMR-691), and the delivery a run
 * journal's pad and frozen artifact name (ADR 0027, MMR-691). The two
 * delivery columns carry no foreign key: an import writes them in any order,
 * and import and doctor check the reference.
 */
export const statements: readonly string[] = [
  `CREATE TABLE delivery_finding (
 delivery_id text NOT NULL REFERENCES delivery(id), number integer NOT NULL,
 kind text NOT NULL CHECK (kind IN ('limitation','declined')), text text NOT NULL, reason text,
 created_at text NOT NULL,
 PRIMARY KEY(delivery_id, number)
 ) STRICT`,
  `ALTER TABLE scratchpad ADD COLUMN delivery text`,
  `ALTER TABLE artifact ADD COLUMN delivery text`,
];
