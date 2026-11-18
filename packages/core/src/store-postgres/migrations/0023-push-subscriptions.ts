/**
 * Migration `0023_push_subscriptions` (MMR-709) — Web Push subscriptions, one
 * row per push-service endpoint. Like device tokens and host secrets, this is
 * host transport data and never enters the work-state transfer document (ADR
 * 0038, ADR 0045 MMR-709 refinement). `server_key` records the VAPID public
 * key the subscription was created against, so a key rotation can drop the
 * rows it orphans.
 */
export const statements = [
  `CREATE TABLE push_subscriptions (
    endpoint text PRIMARY KEY,
    p256dh text NOT NULL,
    auth text NOT NULL,
    server_key text NOT NULL,
    label text NOT NULL,
    created_at text NOT NULL,
    last_success_at text,
    last_failure_at text,
    last_failure text
  )`,
] as const;
