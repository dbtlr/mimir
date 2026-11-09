import { afterEach, describe, expect, test } from 'bun:test';

import { createProject } from './create';
import { chargedTokens, createRunStore } from './runs';
import type { AdmitRun, Run, RunUsage } from './runs';
import { postgresDialect } from './store-postgres/dialect';
import { createPgliteTestStore } from './store-postgres/testing';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';

/** The error an action rejects with, or 'accepted' when it resolves. */
async function failureOf(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
    return 'accepted';
  } catch (error) {
    return error;
  }
}

const STALE_MS = 60_000;
const USAGE: RunUsage = {
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  inputTokens: 100,
  outputTokens: 50,
};

const admission = (id: string, runner = 'host-a'): AdmitRun => ({
  // A budget no test reaches unless it sets its own.
  budget: { dailyTokens: Number.MAX_SAFE_INTEGER, since: '2026-11-01T00:00:00.000Z' },
  id,
  kind: 'groom',
  model: 'opus',
  project: 'MMR',
  reservedTokens: 1000,
  runner,
  staleAfterMs: STALE_MS,
  task: 'MMR-1',
  trigger: 'console',
});

/** A run row with every count zero, for the charge arithmetic. */
const runRow = (fields: Partial<Run>): Run => ({
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_estimate_usd: null,
  ended_at: null,
  heartbeat_at: '2026-11-01T12:00:00.000Z',
  id: 'r',
  input_tokens: 0,
  kind: 'groom',
  model: 'opus',
  outcome: null,
  output_tokens: 0,
  project: 'MMR',
  reserved_tokens: 0,
  runner: 'host-a',
  started_at: '2026-11-01T12:00:00.000Z',
  state: 'running',
  task: 'MMR-1',
  trigger: 'console',
  usage_settled: false,
  ...fields,
});

describe('chargedTokens', () => {
  const streamed = {
    cache_read_tokens: 20,
    cache_write_tokens: 5,
    input_tokens: 100,
    output_tokens: 50,
  };

  test('a settled run counts its settled total, below or above its reservation', () => {
    expect(
      chargedTokens(
        runRow({ ...streamed, reserved_tokens: 1000, state: 'succeeded', usage_settled: true }),
      ),
    ).toBe(175);
    expect(
      chargedTokens(
        runRow({ ...streamed, reserved_tokens: 10, state: 'failed', usage_settled: true }),
      ),
    ).toBe(175);
  });

  test('a running run counts the larger of its reservation and its streamed usage', () => {
    expect(chargedTokens(runRow({ ...streamed, reserved_tokens: 1000 }))).toBe(1000);
    expect(chargedTokens(runRow({ ...streamed, reserved_tokens: 100 }))).toBe(175);
  });

  test('a closed run whose usage never settled counts the larger of reservation and streamed usage', () => {
    for (const state of ['interrupted', 'failed', 'cancelled'] as const) {
      expect(chargedTokens(runRow({ ...streamed, reserved_tokens: 1000, state }))).toBe(1000);
      expect(chargedTokens(runRow({ ...streamed, reserved_tokens: 1, state }))).toBe(175);
    }
  });
});

describe.each([
  { dialect: sqliteDialect, name: 'SQLite', open: createSqliteTestStore },
  { dialect: postgresDialect, name: 'Postgres', open: createPgliteTestStore },
])('$name runs', ({ dialect, name, open }) => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0)) {
      await close();
    }
  });
  async function fixture() {
    const handle = await open();
    closes.push(handle.close);
    let time = new Date('2026-11-01T12:00:00.000Z');
    const runs = createRunStore({ clock: () => time.toISOString(), db: handle.db, dialect });
    return {
      ...handle,
      advance: (ms: number) => {
        time = new Date(time.getTime() + ms);
      },
      runs,
    };
  }

  test('admission inserts a running row with its reservation and zero usage', async () => {
    const { runs } = await fixture();
    const result = await runs.admit(admission('r1'));
    expect(result.admitted).toBe(true);
    expect(await runs.get('r1')).toMatchObject({
      ended_at: null,
      heartbeat_at: '2026-11-01T12:00:00.000Z',
      input_tokens: 0,
      outcome: null,
      reserved_tokens: 1000,
      runner: 'host-a',
      started_at: '2026-11-01T12:00:00.000Z',
      state: 'running',
    });
  });

  test('a second admission is refused by the unique index and names the running run', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    const second = await runs.admit(admission('r2', 'host-b'));
    expect(second).toMatchObject({ admitted: false, reason: 'busy', running: { id: 'r1' } });
    expect(await runs.get('r2')).toBeUndefined();
  });

  // PGlite has one session, so Postgres concurrency is proven in the real-server lane.
  test.skipIf(name === 'Postgres')('simultaneous admissions let exactly one in', async () => {
    const { runs } = await fixture();
    const results = await Promise.all(
      ['a', 'b', 'c'].map((id) => runs.admit(admission(id, `host-${id}`))),
    );
    expect(results.filter((result) => result.admitted)).toHaveLength(1);
  });

  test('a closed run frees the slot', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    await runs.close('r1', 'host-a', {
      costEstimateUsd: 1.5,
      outcome: 'groomed',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    expect((await runs.admit(admission('r2'))).admitted).toBe(true);
  });

  test('the owner heartbeats, records usage, and closes with settled usage and cost', async () => {
    const { advance, runs } = await fixture();
    await runs.admit(admission('r1'));
    advance(10_000);
    expect(await runs.heartbeat('r1', 'host-a')).toBe('held');
    expect(await runs.recordUsage('r1', 'host-a', USAGE)).toBe('held');
    expect(await runs.get('r1')).toMatchObject({
      heartbeat_at: '2026-11-01T12:00:10.000Z',
      input_tokens: 100,
      state: 'running',
    });
    advance(10_000);
    expect(
      await runs.close('r1', 'host-a', {
        costEstimateUsd: 0.25,
        outcome: 'groomed it',
        state: 'succeeded',
        usage: { ...USAGE, outputTokens: 70 },
        usageSettled: true,
      }),
    ).toBe('held');
    expect(await runs.get('r1')).toMatchObject({
      cost_estimate_usd: 0.25,
      ended_at: '2026-11-01T12:00:20.000Z',
      outcome: 'groomed it',
      output_tokens: 70,
      state: 'succeeded',
    });
  });

  test('a different runner loses every write and the row is untouched', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    const before = await runs.get('r1');
    expect(await runs.heartbeat('r1', 'host-b')).toBe('lost');
    expect(await runs.recordUsage('r1', 'host-b', USAGE)).toBe('lost');
    expect(
      await runs.close('r1', 'host-b', {
        costEstimateUsd: null,
        outcome: 'x',
        state: 'failed',
        usage: USAGE,
        usageSettled: true,
      }),
    ).toBe('lost');
    expect(await runs.get('r1')).toEqual(before);
  });

  test('a run no longer running loses writes, and an unknown id loses too', async () => {
    const { advance, runs } = await fixture();
    await runs.admit(admission('r1'));
    advance(STALE_MS + 1);
    expect(await runs.recoverStale(STALE_MS)).toEqual(['r1']);
    const before = await runs.get('r1');
    expect(await runs.heartbeat('r1', 'host-a')).toBe('lost');
    expect(await runs.recordUsage('r1', 'host-a', USAGE)).toBe('lost');
    expect(
      await runs.close('r1', 'host-a', {
        costEstimateUsd: null,
        outcome: 'x',
        state: 'succeeded',
        usage: USAGE,
        usageSettled: true,
      }),
    ).toBe('lost');
    expect(await runs.get('r1')).toEqual(before);
    expect(await runs.heartbeat('nope', 'host-a')).toBe('lost');
  });

  test('stale recovery interrupts only running rows past the window', async () => {
    const { advance, runs } = await fixture();
    await runs.admit(admission('done'));
    await runs.close('done', 'host-a', {
      costEstimateUsd: null,
      outcome: 'ok',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    await runs.admit(admission('live'));
    advance(STALE_MS - 1_000);
    expect(await runs.recoverStale(STALE_MS)).toEqual([]);
    expect((await runs.get('live'))?.state).toBe('running');
    await runs.heartbeat('live', 'host-a');
    advance(STALE_MS - 1_000);
    expect(await runs.recoverStale(STALE_MS)).toEqual([]);
    advance(2_000);
    expect(await runs.recoverStale(STALE_MS)).toEqual(['live']);
    expect(await runs.get('live')).toMatchObject({
      ended_at: '2026-11-01T12:02:00.000Z',
      state: 'interrupted',
    });
    expect((await runs.get('done'))?.state).toBe('succeeded');
  });

  test('admission recovers a stale holder first and then takes the slot', async () => {
    const { advance, runs } = await fixture();
    await runs.admit(admission('old', 'host-a'));
    advance(STALE_MS + 1);
    expect((await runs.admit(admission('new', 'host-b'))).admitted).toBe(true);
    expect((await runs.get('old'))?.state).toBe('interrupted');
    expect((await runs.running())?.id).toBe('new');
  });

  test('re-admitting an existing id is a conflict, whether or not another run is running', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    expect(await failureOf(runs.admit(admission('r1', 'host-b')))).toMatchObject({
      code: 'conflict',
    });
    await runs.close('r1', 'host-a', {
      costEstimateUsd: null,
      outcome: 'ok',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    expect(await failureOf(runs.admit(admission('r1')))).toMatchObject({ code: 'conflict' });
    await runs.admit(admission('r2'));
    expect(await failureOf(runs.admit(admission('r1', 'host-b')))).toMatchObject({
      code: 'conflict',
    });
  });

  test('token counts of 2^31 and above round-trip as numbers', async () => {
    const { runs } = await fixture();
    const big = 2 ** 31 + 5;
    await runs.admit({ ...admission('r1'), reservedTokens: big });
    const usage = {
      cacheReadTokens: big,
      cacheWriteTokens: big + 1,
      inputTokens: big + 2,
      outputTokens: big + 3,
    };
    await runs.recordUsage('r1', 'host-a', usage);
    expect(await runs.get('r1')).toMatchObject({
      cache_read_tokens: big,
      cache_write_tokens: big + 1,
      input_tokens: big + 2,
      output_tokens: big + 3,
      reserved_tokens: big,
    });
  });

  test('the database refuses negative token counts', async () => {
    const { db } = await fixture();
    const row = {
      heartbeat_at: 'h',
      id: 'x',
      kind: 'groom',
      model: 'm',
      project: 'MMR',
      reserved_tokens: 1,
      runner: 'a',
      started_at: 's',
      state: 'failed',
      task: 'MMR-1',
      trigger: 'console',
    } as const;
    for (const column of [
      'reserved_tokens',
      'input_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'output_tokens',
    ] as const) {
      expect(
        await failureOf(
          db
            .insertInto('runs')
            .values({ ...row, [column]: -1 })
            .execute(),
        ),
      ).toBeInstanceOf(Error);
    }
  });

  test('admit and recoverStale refuse a stale window that is not a finite number above zero and at most a day', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001, 1e16]) {
      expect(await failureOf(runs.admit({ ...admission('r2'), staleAfterMs: bad }))).toMatchObject({
        code: 'validation',
      });
      expect(await failureOf(runs.recoverStale(bad))).toMatchObject({ code: 'validation' });
    }
    expect((await runs.get('r1'))?.state).toBe('running');
  });

  test('usage_settled is true only when close is given a settled total', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    expect((await runs.get('r1'))?.usage_settled).toBe(false);
    await runs.recordUsage('r1', 'host-a', USAGE);
    expect((await runs.get('r1'))?.usage_settled).toBe(false);
    await runs.close('r1', 'host-a', {
      costEstimateUsd: null,
      outcome: 'x',
      state: 'failed',
      usage: USAGE,
      usageSettled: false,
    });
    expect((await runs.get('r1'))?.usage_settled).toBe(false);
    await runs.admit(admission('r2'));
    await runs.close('r2', 'host-a', {
      costEstimateUsd: null,
      outcome: 'x',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    expect((await runs.get('r2'))?.usage_settled).toBe(true);
  });

  test('close refuses a state a runner cannot close to, and invalid numbers, before writing', async () => {
    const { runs } = await fixture();
    await runs.admit(admission('r1'));
    const ok = {
      costEstimateUsd: null,
      outcome: 'x',
      state: 'failed',
      usage: USAGE,
      usageSettled: false,
    } as const;
    expect(
      await failureOf(runs.close('r1', 'host-a', { ...ok, state: 'running' as never })),
    ).toMatchObject({ code: 'validation' });
    expect(
      await failureOf(runs.close('r1', 'host-a', { ...ok, state: 'interrupted' as never })),
    ).toMatchObject({ code: 'validation' });
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(
        await failureOf(
          runs.close('r1', 'host-a', { ...ok, usage: { ...USAGE, inputTokens: bad } }),
        ),
      ).toMatchObject({ code: 'validation' });
      expect(
        await failureOf(runs.recordUsage('r1', 'host-a', { ...USAGE, outputTokens: bad })),
      ).toMatchObject({ code: 'validation' });
      expect(
        await failureOf(runs.admit({ ...admission('r2'), reservedTokens: bad })),
      ).toMatchObject({
        code: 'validation',
      });
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        await failureOf(runs.close('r1', 'host-a', { ...ok, costEstimateUsd: bad })),
      ).toMatchObject({ code: 'validation' });
    }
    expect(await runs.get('r1')).toMatchObject({
      ended_at: null,
      input_tokens: 0,
      state: 'running',
    });
  });

  test('a heartbeat exactly at the stale cut-off is not stale', async () => {
    const { advance, runs } = await fixture();
    await runs.admit(admission('r1'));
    advance(STALE_MS);
    expect(await runs.recoverStale(STALE_MS)).toEqual([]);
    advance(1);
    expect(await runs.recoverStale(STALE_MS)).toEqual(['r1']);
  });

  test('admission reports busy, with no holder, when the slot holder ended before it could be read', async () => {
    const { db } = await fixture();
    const raced = {
      ...dialect,
      isUniqueViolation: () => true,
      write: () => Promise.reject(new Error('slot taken')),
    };
    const runs = createRunStore({ db, dialect: raced });
    expect(await runs.admit(admission('r1'))).toEqual({
      admitted: false,
      reason: 'busy',
      running: null,
    });
  });

  test('admission refuses a reservation that does not fit the day, counting each run by its charge', async () => {
    const { advance, runs } = await fixture();
    const day = { dailyTokens: 3_000, since: '2026-11-01T12:00:00.000Z' };
    // Settled at 175, below its 1000 reservation.
    await runs.admit({ ...admission('settled'), budget: day });
    await runs.close('settled', 'host-a', {
      costEstimateUsd: null,
      outcome: 'done',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    // Failed with no valid total: its 1000 reservation.
    await runs.admit({ ...admission('unsettled'), budget: day });
    await runs.close('unsettled', 'host-a', {
      costEstimateUsd: null,
      outcome: 'aborted',
      state: 'failed',
      usage: USAGE,
      usageSettled: false,
    });
    advance(1_000);
    // 1175 used: a 1825 reservation fits exactly, one more token does not.
    expect(await runs.admit({ ...admission('over'), budget: day, reservedTokens: 1_826 })).toEqual({
      admitted: false,
      reason: 'budget',
      used: 1_175,
    });
    expect(await runs.get('over')).toBeUndefined();
    expect(
      (await runs.admit({ ...admission('fits'), budget: day, reservedTokens: 1_825 })).admitted,
    ).toBe(true);
    // Only runs started at or after the day's start count.
    await runs.close('fits', 'host-a', {
      costEstimateUsd: null,
      outcome: 'done',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    const tomorrow = { dailyTokens: 3_000, since: '2026-11-01T12:00:01.001Z' };
    expect(
      (await runs.admit({ ...admission('next'), budget: tomorrow, reservedTokens: 3_000 }))
        .admitted,
    ).toBe(true);
  });

  test('a running run is reported busy, not as a budget refusal, even when the day is spent', async () => {
    const { runs } = await fixture();
    const day = { dailyTokens: 1_000, since: '2026-11-01T00:00:00.000Z' };
    await runs.admit({ ...admission('r1'), budget: day });
    expect(await runs.admit({ ...admission('r2', 'host-b'), budget: day })).toMatchObject({
      admitted: false,
      reason: 'busy',
      running: { id: 'r1' },
    });
  });

  test('admission refuses a budget that is not a token count or a day start that is not an instant', async () => {
    const { runs } = await fixture();
    for (const dailyTokens of [-1, 1.5, Number.NaN]) {
      expect(
        await failureOf(
          runs.admit({
            ...admission('r1'),
            budget: { dailyTokens, since: '2026-11-01T00:00:00Z' },
          }),
        ),
      ).toMatchObject({ code: 'validation' });
    }
    expect(
      await failureOf(
        runs.admit({ ...admission('r1'), budget: { dailyTokens: 1, since: 'yesterday' } }),
      ),
    ).toMatchObject({ code: 'validation' });
    expect(await runs.get('r1')).toBeUndefined();
  });

  test('runs stay out of the transfer document, and an import leaves them intact', async () => {
    const source = await fixture();
    await createProject(source.store, { key: 'MMR', name: 'Mimir' });
    await source.runs.admit(admission('source-run', 'source-runner'));
    const document = await source.store.export();
    expect(JSON.stringify(document)).not.toContain('source-run');
    expect(Object.keys(document)).not.toContain('runs');

    const target = await fixture();
    await target.runs.admit(admission('target-run', 'target-runner'));
    await target.store.import(document, { dryRun: false, mode: 'fresh' });
    expect((await target.runs.running())?.id).toBe('target-run');
    expect(await target.runs.get('source-run')).toBeUndefined();
  });

  test('usage since an instant counts runs started at or after the instant, each by its charge', async () => {
    const { advance, runs } = await fixture();
    // Started before the day: never counted.
    await runs.admit(admission('yesterday'));
    await runs.close('yesterday', 'host-a', {
      costEstimateUsd: null,
      outcome: 'done',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    advance(60_000);
    const dayStart = '2026-11-01T12:01:00.000Z';
    // Settled: its total, 175, below its 1000 reservation.
    await runs.admit(admission('settled'));
    await runs.close('settled', 'host-a', {
      costEstimateUsd: 0.1,
      outcome: 'done',
      state: 'succeeded',
      usage: USAGE,
      usageSettled: true,
    });
    // Failed without a valid total: max(1000 reserved, 175 streamed).
    await runs.admit(admission('unsettled'));
    await runs.close('unsettled', 'host-a', {
      costEstimateUsd: null,
      outcome: 'aborted',
      state: 'failed',
      usage: USAGE,
      usageSettled: false,
    });
    // Interrupted by stale recovery with streamed usage above its reservation: 2000.
    await runs.admit({ ...admission('stale'), reservedTokens: 10 });
    await runs.recordUsage('stale', 'host-a', { ...USAGE, inputTokens: 1925 });
    advance(STALE_MS + 1);
    expect(await runs.recoverStale(STALE_MS)).toEqual(['stale']);
    // Running: max(1000 reserved, 175 streamed).
    await runs.admit(admission('live'));
    await runs.recordUsage('live', 'host-a', USAGE);
    expect(await runs.tokensUsedSince(dayStart)).toBe(175 + 1000 + 2000 + 1000);
    // The instant is canonicalized, so another spelling of it counts the same runs.
    expect(await runs.tokensUsedSince('2026-11-01T07:01:00-05:00')).toBe(4175);
    expect(await runs.tokensUsedSince('2026-11-02T00:00:00.000Z')).toBe(0);
  });

  test("a task's last ended run is its latest by start that is not running, the id breaking a tie", async () => {
    const { advance, runs } = await fixture();
    const closing = {
      costEstimateUsd: null,
      outcome: 'done',
      state: 'succeeded' as const,
      usage: USAGE,
      usageSettled: true,
    };
    expect(await runs.lastEnded('MMR-1')).toBeUndefined();
    // Two runs of MMR-1 started at one instant: the larger id wins the tie.
    await runs.admit(admission('r-b'));
    await runs.close('r-b', 'host-a', closing);
    await runs.admit(admission('r-a'));
    await runs.close('r-a', 'host-a', closing);
    expect((await runs.lastEnded('MMR-1'))?.id).toBe('r-b');
    // A later run on another task is not this task's.
    advance(1_000);
    await runs.admit({ ...admission('other'), task: 'MMR-2' });
    await runs.close('other', 'host-a', closing);
    expect((await runs.lastEnded('MMR-1'))?.id).toBe('r-b');
    // An interrupted run has ended; a running one has not.
    await runs.admit(admission('stale'));
    advance(STALE_MS + 1);
    await runs.recoverStale(STALE_MS);
    await runs.admit(admission('live'));
    expect(await runs.lastEnded('MMR-1')).toMatchObject({ id: 'stale', state: 'interrupted' });
    expect((await runs.lastEnded('MMR-2'))?.id).toBe('other');
  });

  test('usage since refuses an instant that is not a date', async () => {
    const { runs } = await fixture();
    expect(await failureOf(runs.tokensUsedSince('yesterday'))).toMatchObject({
      code: 'validation',
    });
  });
});
