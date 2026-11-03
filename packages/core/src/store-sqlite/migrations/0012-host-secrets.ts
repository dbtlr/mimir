/**
 * Migration `0012_host_secrets` (MMR-624) — sealed host secrets, one row per
 * name. Like device tokens, host transport data never enters the work-state
 * transfer document (ADR 0038, ADR 0040), and the row holds only ciphertext:
 * the key that opens it lives outside the store.
 */
export const statements = [
  `CREATE TABLE host_secrets (
    name text PRIMARY KEY,
    ciphertext text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  ) STRICT`,
] as const;
