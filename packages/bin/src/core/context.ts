import type { Kysely, Transaction } from 'kysely';

import type { DB } from '../db/schema';

/**
 * Executor aliases. Public verbs take a `Db` and open their own transaction;
 * the internal steps thread a `Tx`. `Transaction<DB>` is a `Kysely<DB>`, so a
 * helper typed `Tx` also accepts the root handle in read-only paths.
 */
export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
