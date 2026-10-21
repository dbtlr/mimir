/** Replace host-minted pairing codes with client-requested, host-approved pairing requests (ADR 0038, 2026-10-20 addendum). */
export const statements = [
  `DROP TABLE pairing_codes`,
  `CREATE TABLE pairing_requests (
    id text PRIMARY KEY,
    device text NOT NULL UNIQUE,
    user_code_hash text NOT NULL UNIQUE,
    poll_secret_hash text NOT NULL UNIQUE,
    created_at text NOT NULL,
    expires_at text NOT NULL,
    approved_at text,
    denied_at text,
    CHECK (approved_at IS NULL OR denied_at IS NULL)
  ) STRICT`,
] as const;
