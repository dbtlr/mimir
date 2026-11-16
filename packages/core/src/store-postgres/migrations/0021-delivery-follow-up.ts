/** Delivery-owned follow-up links, with each row retaining its unlink instant. */
export const statements: readonly string[] = [
  `CREATE TABLE delivery_follow_up (
 id bigserial PRIMARY KEY, delivery_id text NOT NULL REFERENCES delivery(id),
 task text REFERENCES node(id), seed text REFERENCES seed(id), linked_at text NOT NULL, unlinked_at text,
 CHECK ((task IS NULL) <> (seed IS NULL)), CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
 )`,
  `CREATE UNIQUE INDEX idx_delivery_follow_up_task ON delivery_follow_up(delivery_id, task) WHERE unlinked_at IS NULL`,
  `CREATE UNIQUE INDEX idx_delivery_follow_up_seed ON delivery_follow_up(delivery_id, seed) WHERE unlinked_at IS NULL`,
  `CREATE INDEX idx_delivery_follow_up_delivery ON delivery_follow_up(delivery_id, id)`,
];
