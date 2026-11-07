import type { Kysely, Selectable, Updateable } from 'kysely';

import type { StoreDialect } from './store-sql/dialect';
import type { DB, RunTable } from './store-sql/schema';
import { now } from './time';

/** One stored run (ADR 0041). */
export type Run = Selectable<RunTable>;

/** The states a run can end in; a runner closes a run to one of the first three. */
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

  const get: RunStore['get'] = (id) =>
    db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst();
  const running: RunStore['running'] = () =>
    db.selectFrom('runs').selectAll().where('state', '=', 'running').executeTakeFirst();

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
        return { admitted: true, run };
      } catch (error) {
        if (!dialect.isUniqueViolation(error)) {
          throw error;
        }
        const holder = await running();
        if (holder === undefined) {
          throw error; // the holder ended between the refusal and this read: let the caller retry
        }
        return { admitted: false, running: holder };
      }
    },
    close: (id, runner, close) =>
      ownedWrite(id, runner, {
        ...usageColumns(close.usage),
        cost_estimate_usd: close.costEstimateUsd,
        ended_at: instant(),
        outcome: close.outcome,
        state: close.state,
      }),
    get,
    heartbeat: (id, runner) => ownedWrite(id, runner, { heartbeat_at: instant() }),
    recordUsage: (id, runner, usage) => ownedWrite(id, runner, usageColumns(usage)),
    recoverStale: async (staleAfterMs) =>
      (await dialect.write(db, (tx) => markStale(tx, staleAfterMs))).map((row) => row.id),
    running,
  };
}
