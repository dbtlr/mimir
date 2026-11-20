import type { ExpressionBuilder, Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { StoreDialect } from './store-sql/dialect';
import type { DB, PushSubscriptionTable } from './store-sql/schema';
import { now } from './time';

/** One Web Push subscription: a push-service endpoint, its keys, and its delivery record. */
export type PushSubscriptionRecord = {
  endpoint: string;
  p256dh: string;
  auth: string;
  serverKey: string;
  label: string;
  createdAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
  /** The event kinds this subscription does not want; the host judges the names. */
  mutedKinds: string[];
};

/** What a send was encrypted for; outcome writes apply only while the row still matches. */
export type PushSubscriptionMatch = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * Web Push subscriptions, one row per endpoint (ADR 0045, MMR-709
 * refinement). The store keeps what it is given; validating endpoints, keys,
 * and labels belongs to the host. Like device tokens, these rows stay outside
 * the Engine and the Store transfer.
 */
export type PushSubscriptionStore = {
  /** Every row, newest created_at first. */
  list: () => Promise<PushSubscriptionRecord[]>;
  get: (endpoint: string) => Promise<PushSubscriptionRecord | undefined>;
  /** Upsert by endpoint. A new endpoint is refused when `limit` rows already exist; the count and the write are one write transaction. An existing endpoint gets the new p256dh, auth, serverKey, label; its last_failure_at and last_failure are cleared; created_at and last_success_at are kept. A given `mutedKinds` is stored; without one, a new row mutes nothing and an existing row keeps its own. */
  subscribe: (
    row: {
      endpoint: string;
      p256dh: string;
      auth: string;
      serverKey: string;
      label: string;
      mutedKinds?: readonly string[];
    },
    limit: number,
  ) => Promise<'subscribed' | 'too_many_devices'>;
  /** Mute or unmute one kind on one row, leaving its other kinds, in one write transaction; returns whether the row exists. */
  setMutedKind: (endpoint: string, kind: string, muted: boolean) => Promise<boolean>;
  /** Delete by endpoint; no row is not an error. Returns whether a row was deleted. */
  remove: (endpoint: string) => Promise<boolean>;
  /** Delete every row whose server_key differs; returns how many. */
  removeOtherKeys: (serverKey: string) => Promise<number>;
  /** Conditional on the match: sets last_success_at, clears the failure. Returns whether a row matched. */
  recordSuccess: (match: PushSubscriptionMatch) => Promise<boolean>;
  /** Conditional on the match: sets last_failure_at and last_failure. */
  recordFailure: (match: PushSubscriptionMatch, failure: string) => Promise<boolean>;
  /** Conditional on the match: deletes the row (a 404/410). */
  removeIfMatches: (match: PushSubscriptionMatch) => Promise<boolean>;
};

/** The stored muted kinds: the strings of a JSON array; anything else mutes nothing. */
function parseMutedKinds(stored: string): string[] {
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value)
      ? value.filter((kind): kind is string => typeof kind === 'string')
      : [];
  } catch {
    return [];
  }
}

function toRecord(row: Selectable<PushSubscriptionTable>): PushSubscriptionRecord {
  return {
    auth: row.auth,
    createdAt: row.created_at,
    endpoint: row.endpoint,
    label: row.label,
    mutedKinds: parseMutedKinds(row.muted_kinds),
    p256dh: row.p256dh,
    serverKey: row.server_key,
    ...(row.last_success_at === null ? {} : { lastSuccessAt: row.last_success_at }),
    ...(row.last_failure_at === null ? {} : { lastFailureAt: row.last_failure_at }),
    ...(row.last_failure === null ? {} : { lastFailure: row.last_failure }),
  };
}

/** The rows that still hold what a send was encrypted for. */
const matching =
  (match: PushSubscriptionMatch) => (eb: ExpressionBuilder<DB, 'push_subscriptions'>) =>
    eb.and([
      eb('endpoint', '=', match.endpoint),
      eb('p256dh', '=', match.p256dh),
      eb('auth', '=', match.auth),
    ]);

/** The push-subscription rows over one store handle. */
export function createPushSubscriptionStore({
  db,
  dialect,
  clock = now,
}: {
  db: Kysely<DB>;
  dialect: StoreDialect;
  clock?: () => string;
}): PushSubscriptionStore {
  // Stored instants are canonical, including those from injected clocks.
  const clockInstant = () => new Date(clock()).toISOString();
  return {
    get: async (endpoint) => {
      const row = await db
        .selectFrom('push_subscriptions')
        .selectAll()
        .where('endpoint', '=', endpoint)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },
    list: async () => {
      const rows = await db
        .selectFrom('push_subscriptions')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('endpoint')
        .execute();
      return rows.map(toRecord);
    },
    recordFailure: async (match, failure) => {
      const result = await dialect.write(db, (tx) =>
        tx
          .updateTable('push_subscriptions')
          .set({ last_failure: failure, last_failure_at: clockInstant() })
          .where(matching(match))
          .executeTakeFirst(),
      );
      return Number(result.numUpdatedRows) > 0;
    },
    recordSuccess: async (match) => {
      const result = await dialect.write(db, (tx) =>
        tx
          .updateTable('push_subscriptions')
          .set({
            last_failure: null,
            last_failure_at: null,
            last_success_at: clockInstant(),
          })
          .where(matching(match))
          .executeTakeFirst(),
      );
      return Number(result.numUpdatedRows) > 0;
    },
    remove: async (endpoint) => {
      const result = await dialect.write(db, (tx) =>
        tx.deleteFrom('push_subscriptions').where('endpoint', '=', endpoint).executeTakeFirst(),
      );
      return Number(result.numDeletedRows) > 0;
    },
    removeIfMatches: async (match) => {
      const result = await dialect.write(db, (tx) =>
        tx.deleteFrom('push_subscriptions').where(matching(match)).executeTakeFirst(),
      );
      return Number(result.numDeletedRows) > 0;
    },
    removeOtherKeys: async (serverKey) => {
      const result = await dialect.write(db, (tx) =>
        tx.deleteFrom('push_subscriptions').where('server_key', '<>', serverKey).executeTakeFirst(),
      );
      return Number(result.numDeletedRows);
    },
    setMutedKind: (endpoint, kind, muted) =>
      dialect.write(db, async (tx) => {
        const row = await tx
          .selectFrom('push_subscriptions')
          .select('muted_kinds')
          .where('endpoint', '=', endpoint)
          .executeTakeFirst();
        if (row === undefined) {
          return false;
        }
        const others = parseMutedKinds(row.muted_kinds).filter((name) => name !== kind);
        await tx
          .updateTable('push_subscriptions')
          .set({ muted_kinds: JSON.stringify(muted ? [...others, kind] : others) })
          .where('endpoint', '=', endpoint)
          .execute();
        return true;
      }),
    subscribe: (row, limit) =>
      dialect.write(db, async (tx) => {
        const existing = await tx
          .selectFrom('push_subscriptions')
          .select('endpoint')
          .where('endpoint', '=', row.endpoint)
          .executeTakeFirst();
        if (existing === undefined) {
          const count = await tx
            .selectFrom('push_subscriptions')
            .select(sql<number | string>`count(*)`.as('n'))
            .executeTakeFirstOrThrow();
          // Postgres answers count(*) as a bigint string; SQLite as a number.
          if (Number(count.n) >= limit) {
            return 'too_many_devices' as const;
          }
        }
        const update = {
          auth: row.auth,
          label: row.label,
          last_failure: null,
          last_failure_at: null,
          p256dh: row.p256dh,
          server_key: row.serverKey,
          ...(row.mutedKinds === undefined ? {} : { muted_kinds: JSON.stringify(row.mutedKinds) }),
        };
        await tx
          .insertInto('push_subscriptions')
          .values({
            ...update,
            created_at: clockInstant(),
            endpoint: row.endpoint,
            last_success_at: null,
          })
          .onConflict((oc) => oc.column('endpoint').doUpdateSet(update))
          .execute();
        return 'subscribed' as const;
      }),
  };
}
