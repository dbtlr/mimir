/**
 * Migration `0024_push_subscription_muted_kinds` (MMR-712) — the event kinds a
 * Web Push subscription does not want, as a JSON array of kind names. Every
 * existing row mutes nothing (ADR 0045, MMR-712 refinement).
 */
export const statements: readonly string[] = [
  "ALTER TABLE push_subscriptions ADD COLUMN muted_kinds text NOT NULL DEFAULT '[]'",
];
