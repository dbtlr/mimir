import { createHash, randomBytes } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';

import { conflict, validation } from './errors';
import type { StoreDialect } from './store-sql/dialect';
import type { DB } from './store-sql/schema';
import { now } from './time';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REQUEST_TTL_MS = 10 * 60 * 1000;
const USAGE_INTERVAL_MS = 5 * 60 * 1000;
const DEVICE_NAME_MAX = 128;
/**
 * Characters that render as nothing or reorder text: every \p{C} (control, format, bidi,
 * surrogate, private use, unassigned), default-ignorables such as fillers and variation
 * selectors, line and paragraph separators, and the braille blank.
 */
const NON_PRINTING = /[\p{C}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\u2800]/u;
/** Seconds a pairing client waits between polls. */
export const PAIRING_POLL_INTERVAL = 2;

type TokenRow = Selectable<DB['device_tokens']>;
export type DeviceToken = Omit<TokenRow, 'token_hash'>;
export type PendingPairing = Pick<
  Selectable<DB['pairing_requests']>,
  'device' | 'created_at' | 'expires_at'
>;
/** What a client receives when it files a pairing request; only it ever sees the poll secret. */
export type PairingRequest = {
  user_code: string;
  poll_secret: string;
  expires_at: string;
  interval: number;
};
/** A poll's answer. Unknown, consumed, and expired requests all answer `expired`. */
export type PairingPoll =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; device: string; token: string };
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
  // SQL expiry comparisons require canonical instants, including injected clocks.
  const clockInstant = () => new Date(clock()).toISOString();
  // Settle the request a poll secret names; the delete makes approval single-use.
  const settle = async (tx: Transaction<DB>, secretHash: string): Promise<PairingPoll> => {
    const at = clockInstant();
    const approved = await tx
      .deleteFrom('pairing_requests')
      .where('poll_secret_hash', '=', secretHash)
      .where('approved_at', 'is not', null)
      .where('expires_at', '>', at)
      .returning('device')
      .executeTakeFirst();
    if (approved !== undefined) {
      return {
        device: approved.device,
        status: 'approved',
        token: await mint(tx, approved.device, at),
      };
    }
    const denied = await tx
      .deleteFrom('pairing_requests')
      .where('poll_secret_hash', '=', secretHash)
      .where('denied_at', 'is not', null)
      .where('expires_at', '>', at)
      .returning('id')
      .executeTakeFirst();
    if (denied !== undefined) {
      return { status: 'denied' };
    }
    const remaining = await tx
      .selectFrom('pairing_requests')
      .select('expires_at')
      .where('poll_secret_hash', '=', secretHash)
      .executeTakeFirst();
    if (remaining !== undefined && Date.parse(remaining.expires_at) > Date.parse(at)) {
      return { status: 'pending' };
    }
    await tx.deleteFrom('pairing_requests').where('poll_secret_hash', '=', secretHash).execute();
    return { status: 'expired' };
  };
  // Approve an undecided request, or deny one not yet denied (withdrawing an
  // uncollected approval), by its user code. Expired requests never match.
  const decide = async (input: string, decision: 'approve' | 'deny') => {
    const code = normalizePairingCode(input);
    if (code === null) {
      return null;
    }
    return dialect.write(db, async (tx) => {
      const at = clockInstant();
      let query = tx
        .updateTable('pairing_requests')
        .set(decision === 'approve' ? { approved_at: at } : { approved_at: null, denied_at: at })
        .where('user_code_hash', '=', hash(code))
        .where('denied_at', 'is', null)
        .where('expires_at', '>', at);
      if (decision === 'approve') {
        query = query.where('approved_at', 'is', null);
      }
      const decided = await query.returning('device').executeTakeFirst();
      if (decided === undefined) {
        return null;
      }
      return { device: decided.device, rotates: await holdsActiveToken(tx, decided.device) };
    });
  };
  return {
    /** Approve a live request by the code its client displays; `rotates` when the device holds an active token. */
    approve: (userCode: string): Promise<{ device: string; rotates: boolean } | null> =>
      decide(userCode, 'approve'),
    /** Deny a live request by its code, including an approval its client has not collected. */
    deny: async (userCode: string): Promise<{ device: string } | null> => {
      const denied = await decide(userCode, 'deny');
      return denied === null ? null : { device: denied.device };
    },
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
    /** Live requests awaiting a decision. Codes are stored hashed, so the operator reads them from the client. */
    listPending: (): Promise<PendingPairing[]> =>
      db
        .selectFrom('pairing_requests')
        .select(['device', 'created_at', 'expires_at'])
        .where('approved_at', 'is', null)
        .where('denied_at', 'is', null)
        .where('expires_at', '>', clockInstant())
        .orderBy('created_at')
        .orderBy('device')
        .execute(),
    /**
     * Read a live undecided request by its code without deciding it, so the
     * console can show what an approval would do. `rotates` is as in `approve`.
     */
    lookup: async (
      userCode: string,
    ): Promise<{
      device: string;
      created_at: string;
      expires_at: string;
      rotates: boolean;
    } | null> => {
      const code = normalizePairingCode(userCode);
      if (code === null) {
        return null;
      }
      // Two reads, not atomic: `rotates` is display-only, and `decide` recomputes it.
      const found = await db
        .selectFrom('pairing_requests')
        .select(['device', 'created_at', 'expires_at'])
        .where('user_code_hash', '=', hash(code))
        .where('approved_at', 'is', null)
        .where('denied_at', 'is', null)
        .where('expires_at', '>', clockInstant())
        .executeTakeFirst();
      return found === undefined
        ? null
        : { ...found, rotates: await holdsActiveToken(db, found.device) };
    },
    poll: async (pollSecret: string): Promise<PairingPoll> => {
      const secretHash = hash(pollSecret);
      // Most polls find an undecided request; answer those without a write transaction.
      const row = await db
        .selectFrom('pairing_requests')
        .select(['approved_at', 'denied_at', 'expires_at'])
        .where('poll_secret_hash', '=', secretHash)
        .executeTakeFirst();
      if (row === undefined) {
        return { status: 'expired' };
      }
      if (
        row.approved_at === null &&
        row.denied_at === null &&
        Date.parse(row.expires_at) > Date.parse(clockInstant())
      ) {
        return { status: 'pending' };
      }
      return dialect.write(db, (tx) => settle(tx, secretHash));
    },
    /**
     * File a pairing request for a device, replacing its pending or denied
     * request. An approved request its client has not collected is refused
     * instead, so another client cannot displace it before the poll.
     */
    request: (input: string): Promise<PairingRequest> => {
      const device = normalizeDeviceName(input);
      if (device === null) {
        return Promise.reject(
          validation(
            'the device name must be 1 to 128 characters without control or invisible characters',
            'name the device with printable text',
          ),
        );
      }
      return dialect.write(db, async (tx) => {
        const created_at = clockInstant();
        const code = Array.from(randomBytes(8), (byte) => CROCKFORD.charAt(byte % 32)).join('');
        const pollSecret = randomBytes(32).toString('base64url');
        const row = {
          approved_at: null,
          created_at,
          denied_at: null,
          device,
          expires_at: new Date(Date.parse(created_at) + REQUEST_TTL_MS).toISOString(),
          id: crypto.randomUUID(),
          poll_secret_hash: hash(pollSecret),
          user_code_hash: hash(code),
        };
        await tx.deleteFrom('pairing_requests').where('expires_at', '<=', created_at).execute();
        const filed = await tx
          .insertInto('pairing_requests')
          .values(row)
          .onConflict((oc) =>
            oc.column('device').doUpdateSet(row).where('pairing_requests.approved_at', 'is', null),
          )
          .returning('id')
          .executeTakeFirst();
        if (filed === undefined) {
          throw conflict(
            `${device} has an approved pairing request its client has not collected`,
            'deny or unpair the device on the host, or wait for the approval to expire',
          );
        }
        return {
          expires_at: row.expires_at,
          interval: PAIRING_POLL_INTERVAL,
          poll_secret: pollSecret,
          user_code: formatPairingCode(code),
        };
      });
    },
    /**
     * Unpair a device: revoke its token and discard its requests, so no
     * approval can still mint. The name matches as typed or as a request would
     * normalize it, so a name stored before normalization stays revocable.
     * Answers how many of each it removed.
     */
    revoke: (input: string): Promise<{ requests: number; tokens: number }> => {
      const devices = [...new Set([input, normalizeDeviceName(input) ?? input])];
      return dialect.write(db, async (tx) => {
        const requests = await tx
          .deleteFrom('pairing_requests')
          .where('device', 'in', devices)
          .executeTakeFirst();
        const tokens = await tx
          .updateTable('device_tokens')
          .set({ revoked_at: clockInstant() })
          .where('device', 'in', devices)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return {
          requests: Number(requests.numDeletedRows),
          tokens: Number(tokens.numUpdatedRows),
        };
      });
    },
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
      const staleBefore = Date.parse(clockInstant()) - USAGE_INTERVAL_MS;
      if (row.last_used_at !== null && Date.parse(row.last_used_at) >= staleBefore) {
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
        const at = clockInstant();
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

// Does the device hold an unrevoked token? Approving it then replaces that token.
async function holdsActiveToken(executor: Kysely<DB> | Transaction<DB>, device: string) {
  const active = await executor
    .selectFrom('device_tokens')
    .select('id')
    .where('device', '=', device)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return active !== undefined;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Rotate at mint: the device's prior token stops verifying when the new one is issued.
async function mint(tx: Transaction<DB>, device: string, at: string): Promise<string> {
  await tx
    .updateTable('device_tokens')
    .set({ revoked_at: at })
    .where('device', '=', device)
    .where('revoked_at', 'is', null)
    .execute();
  const token = randomBytes(32).toString('base64url');
  await tx
    .insertInto('device_tokens')
    .values({
      created_at: at,
      device,
      id: crypto.randomUUID(),
      last_used_at: null,
      revoked_at: null,
      token_hash: hash(token),
    })
    .execute();
  return token;
}

/** Accept the printed separator and Crockford's O/I/L confusables. */
export function normalizePairingCode(code: string): string | null {
  if (!/^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code)) {
    return null;
  }
  const normalized = code.toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/.test(normalized)
    ? normalized.replace('-', '')
    : null;
}

/** Print a normalized code as `XXXX-XXXX`, the form clients display. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Normalize a device name to NFC, trimmed, with each run of spaces as one ASCII space;
 * refuse an empty, overlong, or non-printing name. Two names that render alike must
 * normalize alike, so a request cannot pass for a paired device on an approval card.
 * Emoji that need a joiner or variation selector are refused with the rest.
 */
export function normalizeDeviceName(name: string): string | null {
  const normalized = name
    .normalize('NFC')
    .trim()
    .replace(/\p{Zs}+/gu, ' ');
  return normalized.length > 0 &&
    normalized.length <= DEVICE_NAME_MAX &&
    !NON_PRINTING.test(normalized)
    ? normalized
    : null;
}
