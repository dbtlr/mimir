/**
 * The indexes the since read needs (ADR 0042, MMR-692): the artifacts and
 * decisions that name a delivery, and the decision history rows that name one
 * as the delivery moved from or to. Without them each read scans those tables
 * whole.
 */
export const statements: readonly string[] = [
  `CREATE INDEX idx_artifact_delivery ON artifact(delivery)`,
  `CREATE INDEX idx_decision_delivery ON decision(delivery)`,
  `CREATE INDEX idx_decision_history_from ON decision_history(kind, from_value)`,
  `CREATE INDEX idx_decision_history_to ON decision_history(kind, to_value)`,
];
