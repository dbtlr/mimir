import type { Kysely, Selectable, Updateable } from 'kysely';

import { conflict, validation } from './errors';
import type { StoreDialect } from './store-sql/dialect';
import type { DB, RunTable } from './store-sql/schema';
import { now } from './time';

/** One stored run (ADR 0041), with its token counts as numbers and `usage_settled` as a boolean. */
export type Run = Omit<Selectable<RunTable>, 'usage_settled'> & { usage_settled: boolean };

/**
 * The states a runner closes its own run to. Only stale recovery sets
 * `interrupted`, so a runner never passes it.
 */
export type RunClosingState = 'succeeded' | 'failed' | 'cancelled';

/** Token counts for a run, as streamed or settled. */
export type RunUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

export type AdmitRun = {
  id: string;
  project: string;
  task: string;
  kind: Run['kind'];
  trigger: Run['trigger'];
  runner: string;
  model: string;
  reservedTokens: number;
  /** A running row whose heartbeat is older than this many ms is interrupted before the insert. */
  staleAfterMs: number;
};

/** Admission either inserts the running row or reports the run that holds the slot. */
export type AdmitResult = { admitted: true; run: Run } | { admitted: false; running: Run };

/** `held` means the write landed; `lost` means no running row matched id and runner. */
export type RunWrite = 'held' | 'lost';

export type CloseRun = {
  state: RunClosingState;
  outcome: string;
  usage: RunUsage;
  /**
   * True when `usage` is the settled total from the run's result, which replaces
   * the reservation. False when it is only the streamed usage, so an interrupted
   * or failed run with no valid total counts the larger of reservation and usage.
   */
  usageSettled: boolean;
  costEstimateUsd: number | null;
};

/**
 * The host-only run records (ADR 0041). Like host secrets, these rows stay
 * outside the Engine and the Store transfer. Every write after admission is
 * one conditional UPDATE on id, runner, and state = 'running'.
 */
export type RunStore = {
  admit: (input: AdmitRun) => Promise<AdmitResult>;
  heartbeat: (id: string, runner: string) => Promise<RunWrite>;
  recordUsage: (id: string, runner: string, usage: RunUsage) => Promise<RunWrite>;
  close: (id: string, runner: string, close: CloseRun) => Promise<RunWrite>;
  /** Mark running rows with a heartbeat older than staleAfterMs interrupted; returns their ids. */
  recoverStale: (staleAfterMs: number) => Promise<string[]>;
  get: (id: string) => Promise<Run | undefined>;
  /** The run holding the single running slot, if any. */
  running: () => Promise<Run | undefined>;
};

const usageColumns = (usage: RunUsage) => ({
  cache_read_tokens: usage.cacheReadTokens,
  cache_write_tokens: usage.cacheWriteTokens,
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
});

// The driver may hand a bigint column over as a string.
const asCount = (value: unknown): number => Number(value);

const CLOSING_STATES = new Set<string>(['succeeded', 'failed', 'cancelled']);

const assertTokenCount = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validation(`${name} must be a non-negative safe integer, got ${value}`);
  }
};

const assertUsage = (usage: RunUsage) => {
  assertTokenCount('inputTokens', usage.inputTokens);
  assertTokenCount('cacheReadTokens', usage.cacheReadTokens);
  assertTokenCount('cacheWriteTokens', usage.cacheWriteTokens);
  assertTokenCount('outputTokens', usage.outputTokens);
};

const assertStaleWindow = (staleAfterMs: number) => {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw validation(`staleAfterMs must be a finite number above 0, got ${staleAfterMs}`);
  }
};

/** The run rows over one store handle. */
export function createRunStore({
  db,
  dialect,
  clock = now,
}: {
  db: Kysely<DB>;
  dialect: StoreDialect;
  clock?: () => string;
}): RunStore {
  // Stored instants are canonical, including those from injected clocks.
  const clockMs = () => new Date(clock()).getTime();
  const instant = (ms: number = clockMs()) => new Date(ms).toISOString();

  // Postgres returns bigint columns as strings and SQLite stores booleans as 0/1.
  const toRun = (row: Selectable<RunTable>): Run => ({
    ...row,
    cache_read_tokens: asCount(row.cache_read_tokens),
    cache_write_tokens: asCount(row.cache_write_tokens),
    input_tokens: asCount(row.input_tokens),
    output_tokens: asCount(row.output_tokens),
    reserved_tokens: asCount(row.reserved_tokens),
    usage_settled: dialect.codecs.bool.decode(row.usage_settled),
  });
  const get: RunStore['get'] = async (id) => {
    const row = await db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  };
  const running: RunStore['running'] = async () => {
    const row = await db
      .selectFrom('runs')
      .selectAll()
      .where('state', '=', 'running')
      .executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  };

  // The one ownership check: id, runner, and still running, in the UPDATE itself.
  const ownedWrite = async (
    id: string,
    runner: string,
    set: Updateable<RunTable>,
  ): Promise<RunWrite> => {
    const result = await dialect.write(db, (tx) =>
      tx
        .updateTable('runs')
        .set(set)
        .where('id', '=', id)
        .where('runner', '=', runner)
        .where('state', '=', 'running')
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 0 ? 'lost' : 'held';
  };

  const markStale = (tx: Kysely<DB>, staleAfterMs: number) => {
    const at = clockMs();
    return tx
      .updateTable('runs')
      .set({
        ended_at: instant(at),
        outcome: 'interrupted: the runner stopped heartbeating',
        state: 'interrupted',
      })
      .where('state', '=', 'running')
      .where('heartbeat_at', '<', instant(at - staleAfterMs))
      .returning('id')
      .execute();
  };

  return {
    admit: async (input) => {
      assertStaleWindow(input.staleAfterMs);
      assertTokenCount('reservedTokens', input.reservedTokens);
      const at = instant();
      try {
        const run = await dialect.write(db, async (tx) => {
          await markStale(tx, input.staleAfterMs);
          return tx
            .insertInto('runs')
            .values({
              heartbeat_at: at,
              id: input.id,
              kind: input.kind,
              model: input.model,
              project: input.project,
              reserved_tokens: input.reservedTokens,
              runner: input.runner,
              started_at: at,
              state: 'running',
              task: input.task,
              trigger: input.trigger,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        });
        return { admitted: true, run: toRun(run) };
      } catch (error) {
        if (!dialect.isUniqueViolation(error)) {
          throw error;
        }
        // A primary-key clash is the caller's bug, not a busy slot.
        if ((await get(input.id)) !== undefined) {
          throw conflict(`run ${input.id} already exists`, 'admit each run under a fresh id');
        }
        const holder = await running();
        if (holder === undefined) {
          // The running-slot index refused the insert, but its holder ended before this read.
          throw conflict('the running slot changed during admission', 'retry the admission');
        }
        return { admitted: false, running: holder };
      }
    },
    close: async (id, runner, close) => {
      if (!CLOSING_STATES.has(close.state)) {
        throw validation(`a run closes as succeeded, failed, or cancelled, not ${close.state}`);
      }
      assertUsage(close.usage);
      if (close.costEstimateUsd !== null && !Number.isFinite(close.costEstimateUsd)) {
        throw validation('costEstimateUsd must be a finite number or null');
      }
      return ownedWrite(id, runner, {
        ...usageColumns(close.usage),
        cost_estimate_usd: close.costEstimateUsd,
        ended_at: instant(),
        outcome: close.outcome,
        state: close.state,
        usage_settled: dialect.codecs.bool.encode(close.usageSettled),
      });
    },
    get,
    heartbeat: (id, runner) => ownedWrite(id, runner, { heartbeat_at: instant() }),
    recordUsage: async (id, runner, usage) => {
      assertUsage(usage);
      return ownedWrite(id, runner, usageColumns(usage));
    },
    recoverStale: async (staleAfterMs) => {
      assertStaleWindow(staleAfterMs);
      return (await dialect.write(db, (tx) => markStale(tx, staleAfterMs))).map((row) => row.id);
    },
    running,
  };
}
