/** Host transport credentials never enter the work-state transfer document (ADR 0038). */
export const statements = [
  `CREATE TABLE pairing_codes (
    device text PRIMARY KEY,
    code_hash text NOT NULL UNIQUE,
    created_at text NOT NULL,
    expires_at text NOT NULL
  ) STRICT`,
  `CREATE TABLE device_tokens (
    id text PRIMARY KEY,
    "user" text NOT NULL DEFAULT 'owner',
    device text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at text NOT NULL,
    last_used_at text,
    revoked_at text
  ) STRICT`,
  `CREATE UNIQUE INDEX device_tokens_active_device ON device_tokens (device) WHERE revoked_at IS NULL`,
] as const;
