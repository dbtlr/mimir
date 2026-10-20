import { createHash, randomBytes } from 'node:crypto';

import type { Kysely, Selectable } from 'kysely';

import type { StoreDialect } from './store-sql/dialect';
import type { DB } from './store-sql/schema';
import { now } from './time';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_TTL_MS = 10 * 60 * 1000;
const USAGE_INTERVAL_MS = 5 * 60 * 1000;

type TokenRow = Selectable<DB['device_tokens']>;
export type DeviceToken = Omit<TokenRow, 'token_hash'>;
export type TokenStore = ReturnType<typeof createTokenStore>;

/** Host transport credentials, deliberately outside the Engine and Store transfer. */
export function createTokenStore({
  db,
  dialect,
  clock = now,
}: {
  db: Kysely<DB>;
  dialect: StoreDialect;
  clock?: () => string;
}) {
  return {
    issueCode: (device: string) =>
      dialect.write(db, async (tx) => {
        const code = Array.from(randomBytes(8), (byte) => CROCKFORD.charAt(byte % 32)).join('');
        const created_at = clock();
        const row = {
          code_hash: hash(code),
          created_at,
          device,
          expires_at: new Date(Date.parse(created_at) + CODE_TTL_MS).toISOString(),
        };
        await tx
          .insertInto('pairing_codes')
          .values(row)
          .onConflict((oc) => oc.column('device').doUpdateSet(row))
          .execute();
        return code;
      }),
    list: async ({ all = false }: { all?: boolean } = {}): Promise<DeviceToken[]> => {
      let query = db
        .selectFrom('device_tokens')
        .select(['id', 'user', 'device', 'created_at', 'last_used_at', 'revoked_at'])
        .orderBy('device')
        .orderBy('created_at')
        .orderBy('id');
      if (!all) {
        query = query.where('revoked_at', 'is', null);
      }
      return query.execute();
    },
    redeem: async (input: string): Promise<{ token: string; device: string } | null> => {
      const code = normalizePairingCode(input);
      if (code === null) {
        return null;
      }
      return dialect.write(db, async (tx) => {
        const at = clock();
        const pending = await tx
          .deleteFrom('pairing_codes')
          .where('code_hash', '=', hash(code))
          .where('expires_at', '>', at)
          .returning('device')
          .executeTakeFirst();
        if (pending === undefined) {
          return null;
        }
        await tx
          .updateTable('device_tokens')
          .set({ revoked_at: at })
          .where('device', '=', pending.device)
          .where('revoked_at', 'is', null)
          .execute();
        const token = randomBytes(32).toString('base64url');
        await tx
          .insertInto('device_tokens')
          .values({
            created_at: at,
            device: pending.device,
            id: crypto.randomUUID(),
            last_used_at: null,
            revoked_at: null,
            token_hash: hash(token),
          })
          .execute();
        return { device: pending.device, token };
      });
    },
    revoke: (device: string) =>
      dialect.write(db, async (tx) => {
        await tx
          .updateTable('device_tokens')
          .set({ revoked_at: clock() })
          .where('device', '=', device)
          .where('revoked_at', 'is', null)
          .execute();
      }),
    verify: async (token: string): Promise<string | null> => {
      const tokenHash = hash(token);
      const row = await db
        .selectFrom('device_tokens')
        .select(['device', 'last_used_at'])
        .where('token_hash', '=', tokenHash)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (row === undefined) {
        return null;
      }
      const staleBefore = new Date(Date.parse(clock()) - USAGE_INTERVAL_MS).toISOString();
      if (row.last_used_at !== null && row.last_used_at >= staleBefore) {
        return row.device;
      }
      // Recheck revocation and staleness after acquiring the write transaction:
      // another verifier or an operator may have changed this token meanwhile.
      return dialect.write(db, async (tx) => {
        const active = await tx
          .selectFrom('device_tokens')
          .select(['device', 'last_used_at'])
          .where('token_hash', '=', tokenHash)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (active === undefined) {
          return null;
        }
        const at = clock();
        if (
          active.last_used_at === null ||
          Date.parse(at) - Date.parse(active.last_used_at) > USAGE_INTERVAL_MS
        ) {
          await tx
            .updateTable('device_tokens')
            .set({ last_used_at: at })
            .where('token_hash', '=', tokenHash)
            .where('revoked_at', 'is', null)
            .execute();
        }
        return active.device;
      });
    },
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Accept the printed separator and Crockford's O/I/L confusables. */
export function normalizePairingCode(code: string): string | null {
  const normalized = code.toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/.test(normalized)
    ? normalized.replace('-', '')
    : null;
}
