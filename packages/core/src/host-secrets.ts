import type { Kysely } from 'kysely';

import type { StoreDialect } from './store-sql/dialect';
import type { DB } from './store-sql/schema';
import { now } from './time';

/**
 * Sealed host secrets, one row per name (ADR 0040). The store keeps only the
 * text `sealSecret` produced; sealing and opening, and the key, belong to
 * the caller. Like device tokens, these rows stay outside the Engine and the
 * Store transfer.
 */
export type HostSecretStore = {
  /** The sealed text stored under name, or undefined. */
  read: (name: string) => Promise<string | undefined>;
  /** Insert or replace; sets created_at on insert and updated_at on every write. */
  write: (name: string, sealed: string) => Promise<void>;
};

/** The host-secret rows over one store handle. */
export function createHostSecretStore({
  db,
  dialect,
  clock = now,
}: {
  db: Kysely<DB>;
  dialect: StoreDialect;
  clock?: () => string;
}): HostSecretStore {
  // Stored instants are canonical, including those from injected clocks.
  const clockInstant = () => new Date(clock()).toISOString();
  return {
    read: async (name) => {
      const row = await db
        .selectFrom('host_secrets')
        .select('ciphertext')
        .where('name', '=', name)
        .executeTakeFirst();
      return row?.ciphertext;
    },
    write: (name, sealed) =>
      dialect.write(db, async (tx) => {
        const at = clockInstant();
        await tx
          .insertInto('host_secrets')
          .values({ ciphertext: sealed, created_at: at, name, updated_at: at })
          .onConflict((oc) => oc.column('name').doUpdateSet({ ciphertext: sealed, updated_at: at }))
          .execute();
      }),
  };
}
