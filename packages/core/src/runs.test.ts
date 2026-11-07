import { afterEach, describe, expect, test } from 'bun:test';

import { createProject } from './create';
import { createRunStore } from './runs';
import type { AdmitRun, RunUsage } from './runs';
import { postgresDialect } from './store-postgres/dialect';
import { createPgliteTestStore } from './store-postgres/testing';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';

const STALE_MS = 60_000;
const USAGE: RunUsage = {
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  inputTokens: 100,
  outputTokens: 50,
};

const admission = (id: string, runner = 'host-a'): AdmitRun => ({
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
    expect(second.admitted).toBe(false);
    expect(second.admitted ? undefined : second.running.id).toBe('r1');
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
});
