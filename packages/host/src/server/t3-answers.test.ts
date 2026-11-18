import { describe, expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import { parseSecretKey, sealSecret } from '@mimir/core';

import { writeDecisionAnswers } from './decision-answer-writes';
import type { DecisionAnswerWrites } from './decision-answer-writes';
import { parseAnswerDecisions } from './decision-answers';
import type { AnswerDecisionsInput, DecisionAnswer } from './decision-answers';
import { createT3Adapter, T3_SECRET_NAME } from './t3';
import type { T3AdapterOptions } from './t3';
import type { T3Settings } from './t3-settings';
import { memorySecrets, STUB_ACCESS_TOKEN, stubT3 } from './t3-stub';
import { parseWakeInput } from './t3-wake';

const T3 = 'https://t3.example';
const KEY = parseSecretKey(Buffer.alloc(32, 7).toString('base64'))!;
const NOW = Date.parse('2026-11-18T09:10:02.311Z');
const SINCE = '2026-11-18T09:10:02.310Z';
const ATTEMPT = 'attempt-0000000001';

const ready: T3Settings = {
  consoleUrl: 'https://mimir.example',
  enabled: true,
  key: KEY,
  problems: [],
  url: T3,
};

type Behavior = 'fault' | 'invariant' | 'ok' | 'refuse';

/**
 * A Send over a fake Engine of decisions {id: delivery}, waking through a
 * real adapter over a stub T3; `behave` scripts each write by decision id.
 */
function harness(
  options: {
    decisions?: Record<string, string | null>;
    behave?: Record<string, Behavior>;
    settings?: T3Settings;
    harnessName?: string;
  } = {},
) {
  const decisions = options.decisions ?? {
    'MMR-q1': 'MMR-d3',
    'MMR-q2': 'MMR-d3',
    'MMR-q3': 'MMR-d3',
    'MMR-q7': 'MMR-d8',
    'MMR-q9': null,
  };
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const clock = { now: NOW };
  const write = (verb: string) => async (input: { id: string }) => {
    calls.push(`${verb} ${input.id}`);
    inputs.push(input);
    switch (options.behave?.[input.id] ?? 'ok') {
      case 'refuse': {
        throw new MimirError('conflict', `${input.id} is already confirmed`);
      }
      case 'invariant': {
        throw new MimirError('invariant', 'row vanished: secret operator text');
      }
      case 'fault': {
        throw new Error('disk on fire');
      }
      default: {
        return { id: input.id };
      }
    }
  };
  const engine = {
    confirm: write('confirm'),
    getDecision: async ({ id }: { id: string }) => {
      calls.push(`read ${id}`);
      clock.now += 5;
      if (!(id in decisions)) {
        throw new MimirError('not_found', `${id} doesn't exist`);
      }
      return { delivery: decisions[id], id };
    },
    getDelivery: async ({ id }: { id: string }) => {
      calls.push(`delivery ${id}`);
      return {
        harness: options.harnessName ?? 't3',
        host: 'env-valhalla',
        id,
        session: 'thread-9',
      };
    },
    overturn: write('overturn'),
  };
  const stub = stubT3({
    configured: 'env-valhalla',
    environments: { 'env-valhalla': { label: 'Valhalla', projects: [] } },
    origin: T3,
  });
  const secrets = memorySecrets();
  secrets.rows.set(
    T3_SECRET_NAME,
    sealSecret(
      KEY,
      T3_SECRET_NAME,
      JSON.stringify({
        accessToken: STUB_ACCESS_TOKEN,
        expiresAt: new Date(NOW + 86_400_000).toISOString(),
        issuer: T3,
      }),
    ),
  );
  const logs: string[] = [];
  const adapter = createT3Adapter({
    clock: () => clock.now,
    engine: engine as unknown as T3AdapterOptions['engine'],
    fetch: stub.fetch,
    log: (line) => logs.push(line),
    secrets,
    settings: options.settings ?? ready,
    timeoutMs: 1000,
    version: '0.29.0',
  });
  const answer = (input: unknown) =>
    writeDecisionAnswers(
      {
        clock: () => clock.now,
        engine: engine as unknown as DecisionAnswerWrites['engine'],
        log: (line) => logs.push(line),
        wake: adapter.wakeAfterAnswers,
      },
      input,
    );
  return { adapter, answer, calls, inputs, logs, stub };
}

const overturn = (id: string): DecisionAnswer => ({ id, option: 2, verdict: 'overturn' });
const confirm = (id: string): DecisionAnswer => ({ id, verdict: 'confirm' });
const send = (
  answers: DecisionAnswer[],
  delivery: string | null = 'MMR-d3',
): AnswerDecisionsInput => ({
  answers,
  attempt: ATTEMPT,
  delivery,
});

describe('answerDecisions: the answers', () => {
  test('writes each answer in input order, reading before writing', async () => {
    const h = harness();
    const out = await h.answer(send([overturn('MMR-q2'), confirm('MMR-q1')]));
    expect(h.calls.filter((call) => !call.startsWith('delivery'))).toEqual([
      'read MMR-q2',
      'overturn MMR-q2',
      'read MMR-q1',
      'confirm MMR-q1',
    ]);
    expect(out.results.map((r) => [r.id, r.outcome])).toEqual([
      ['MMR-q2', 'overturned'],
      ['MMR-q1', 'confirmed'],
    ]);
  });

  test('a refusal does not stop later answers', async () => {
    const h = harness({ behave: { 'MMR-q1': 'refuse' } });
    const out = await h.answer(send([confirm('MMR-q1'), overturn('MMR-q2')]));
    expect(out.results[0]).toEqual({
      id: 'MMR-q1',
      outcome: 'refused',
      reason: 'MMR-q1 is already confirmed',
    });
    expect(out.results[1]?.outcome).toBe('overturned');
  });

  test('a refused read is refused with the Engine message', async () => {
    const h = harness();
    const out = await h.answer(send([confirm('MMR-q50'), overturn('MMR-q2')]));
    expect(out.results[0]).toEqual({
      id: 'MMR-q50',
      outcome: 'refused',
      reason: "MMR-q50 doesn't exist",
    });
    expect(h.calls).not.toContain('confirm MMR-q50');
  });

  test('a decision in another delivery, or none, is refused and nothing is written', async () => {
    const h = harness();
    const out = await h.answer(send([overturn('MMR-q7'), overturn('MMR-q9')]));
    expect(out.results.map((r) => r.outcome)).toEqual(['refused', 'refused']);
    expect(h.calls).toEqual(['read MMR-q7', 'read MMR-q9']);
    expect(JSON.stringify(out.results)).toContain('not in this walkthrough');
  });

  test('a null delivery refuses a decision that names one, and accepts one that names none', async () => {
    const h = harness();
    const out = await h.answer(send([confirm('MMR-q1'), confirm('MMR-q9')], null));
    expect(out.results.map((r) => r.outcome)).toEqual(['refused', 'confirmed']);
  });

  test('an invariant error and a plain error are failed, logged by class and code, and carry no text', async () => {
    const h = harness({ behave: { 'MMR-q1': 'invariant', 'MMR-q2': 'fault' } });
    const out = await h.answer(send([confirm('MMR-q1'), confirm('MMR-q2'), confirm('MMR-q3')]));
    expect(out.results).toMatchObject([
      { id: 'MMR-q1', outcome: 'failed' },
      { id: 'MMR-q2', outcome: 'failed' },
      { id: 'MMR-q3', outcome: 'confirmed' },
    ]);
    const faults = h.logs
      .map((l) => JSON.parse(l) as Record<string, string>)
      .filter((l) => l.event === 'decision_answer_fault');
    expect(faults.map(({ code, decision, error }) => ({ code, decision, error }))).toEqual([
      { code: 'invariant', decision: 'MMR-q1', error: 'MimirError' },
      { code: undefined, decision: 'MMR-q2', error: 'Error' },
    ]);
    expect(h.logs.join('\n')).not.toContain('secret operator text');
    expect(h.logs.join('\n')).not.toContain('disk on fire');
  });

  test('a note and an option reach the Engine as given, and absent ones are not sent', async () => {
    const h = harness();
    await h.answer(
      send([
        { id: 'MMR-q1', note: 'why', verdict: 'confirm' },
        { id: 'MMR-q2', note: 'because', option: 3, verdict: 'overturn' },
        { id: 'MMR-q3', verdict: 'confirm' },
      ]),
    );
    expect(h.inputs).toEqual([
      { id: 'MMR-q1', note: 'why' },
      { id: 'MMR-q2', note: 'because', option: 3 },
      { id: 'MMR-q3' },
    ]);
  });
});

describe('answerDecisions: the wake', () => {
  test('one overturn sends one wake with the fixed phrase and the since before the first read', async () => {
    const h = harness();
    const out = await h.answer(send([overturn('MMR-q1'), confirm('MMR-q2')]));
    expect(out.wake).toEqual({ state: 'sent' });
    expect(h.stub.wakes).toHaveLength(1);
    expect(h.stub.wakes[0]).toMatchObject({
      clientRequestId: `mimir:wake:${ATTEMPT}`,
      environmentId: 'env-valhalla',
      message: `Mimir: the operator answered decisions on delivery MMR-d3. Read what changed: mimir get MMR-d3 --since ${SINCE}`,
      threadId: 'thread-9',
    });
  });

  test('several overturns still send one wake', async () => {
    const h = harness();
    await h.answer(send([overturn('MMR-q1'), overturn('MMR-q2'), overturn('MMR-q3')]));
    expect(h.stub.wakes).toHaveLength(1);
  });

  test('confirms only skip no_overturn', async () => {
    const h = harness();
    const out = await h.answer(send([confirm('MMR-q1')]));
    expect(out.wake).toEqual({ reason: 'no_overturn', state: 'skipped' });
    expect(h.stub.wakes).toEqual([]);
  });

  test('a refused overturn is no overturn', async () => {
    const h = harness({ behave: { 'MMR-q1': 'refuse' } });
    const out = await h.answer(send([overturn('MMR-q1')]));
    expect(out.wake).toEqual({ reason: 'no_overturn', state: 'skipped' });
  });

  test('a null delivery skips no_delivery', async () => {
    const h = harness();
    const out = await h.answer(send([overturn('MMR-q9')], null));
    expect(out.wake).toEqual({ reason: 'no_delivery', state: 'skipped' });
  });

  test('confirms only with a null delivery skip no_delivery, before the overturn check', async () => {
    const h = harness();
    const out = await h.answer(send([confirm('MMR-q9')], null));
    expect(out.wake).toEqual({ reason: 'no_delivery', state: 'skipped' });
  });

  test('an unset feature skips unconfigured before the other checks', async () => {
    const h = harness({ settings: { enabled: false } });
    const out = await h.answer(send([confirm('MMR-q9')], null));
    expect(out.wake).toEqual({ reason: 'unconfigured', state: 'skipped' });
    expect(out.results[0]?.outcome).toBe('confirmed');
  });

  test('a delivery not in T3 skips no_thread, read after the writes', async () => {
    const h = harness({ harnessName: 'claude' });
    const out = await h.answer(send([overturn('MMR-q1')]));
    expect(out.wake).toEqual({ reason: 'no_thread', state: 'skipped' });
    expect(h.calls.indexOf('delivery MMR-d3')).toBeGreaterThan(h.calls.indexOf('overturn MMR-q1'));
  });

  test('a sent wake logs t3_wake with the delivery', async () => {
    const h = harness();
    await h.answer(send([overturn('MMR-q1')]));
    expect(JSON.parse(h.logs.at(-1) ?? '')).toMatchObject({
      delivery: 'MMR-d3',
      event: 't3_wake',
      outcome: 'sent',
    });
  });
});

describe('answerDecisions: Retry', () => {
  test('wakeT3 accepts answerDecisions with a null decision and resends', async () => {
    const h = harness();
    const input = {
      action: 'answerDecisions',
      attempt: ATTEMPT,
      decision: null,
      delivery: 'MMR-d3',
      since: SINCE,
    };
    expect(await h.adapter.wakeT3(input)).toEqual({ state: 'sent' });
    expect(h.stub.wakes[0]?.message).toContain('answered decisions on delivery MMR-d3');
  });

  test('wakeT3 reads invalid naming decision when one is given', async () => {
    const h = harness();
    expect(
      await h.adapter.wakeT3({
        action: 'answerDecisions',
        attempt: ATTEMPT,
        decision: 'MMR-q1',
        delivery: 'MMR-d3',
        since: SINCE,
      }),
    ).toEqual({ field: 'decision', state: 'invalid' });
    expect(h.stub.wakes).toEqual([]);
  });

  test('parseWakeInput accepts the retry shape', () => {
    expect(
      parseWakeInput({
        action: 'answerDecisions',
        attempt: ATTEMPT,
        decision: null,
        delivery: 'MMR-d3',
        since: SINCE,
      }),
    ).toMatchObject({ action: 'answerDecisions', decision: null });
  });
});

const refuses = (input: unknown) => {
  expect(() => parseAnswerDecisions(input)).toThrow(MimirError);
  try {
    parseAnswerDecisions(input);
  } catch (error) {
    expect((error as MimirError).code).toBe('validation');
  }
};

describe('parseAnswerDecisions: the input checks', () => {
  test('canonicalizes ids', () => {
    expect(
      parseAnswerDecisions({
        answers: [{ id: 'MMR-q07', verdict: 'confirm' }],
        attempt: ATTEMPT,
        delivery: 'MMR-d03',
      }),
    ).toEqual({
      answers: [{ id: 'MMR-q7', verdict: 'confirm' }],
      attempt: ATTEMPT,
      delivery: 'MMR-d3',
    });
  });

  test('refuses a bad attempt', () => {
    refuses({ ...send([confirm('MMR-q1')]), attempt: 'short' });
  });

  test('refuses a bad delivery or decision id', () => {
    refuses(send([confirm('MMR-q1')], 'MMR-3'));
    refuses(send([confirm('MMR-4')]));
    refuses(send([confirm('mmr-q1')]));
  });

  test('refuses duplicates after canonicalization, and nothing is written', async () => {
    const input = send([confirm('MMR-q07'), confirm('MMR-q7')]);
    refuses(input);
    const h = harness();
    const error = await h.answer(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MimirError);
    expect(h.calls).toEqual([]);
  });

  test('refuses answers across projects, or outside the delivery project', () => {
    refuses(send([confirm('MMR-q1'), confirm('ABC-q2')], null));
    refuses(send([confirm('ABC-q2')], 'MMR-d3'));
  });

  test('refuses none and more than 100 answers', () => {
    refuses(send([]));
    refuses(send(Array.from({ length: 101 }, (_, i) => confirm(`MMR-q${String(i + 1)}`))));
    expect(
      parseAnswerDecisions(
        send(Array.from({ length: 100 }, (_, i) => confirm(`MMR-q${String(i + 1)}`))),
      ).answers,
    ).toHaveLength(100);
  });

  test('refuses an answer of the wrong shape', () => {
    refuses(send([{ id: 'MMR-q1', verdict: 'maybe' } as unknown as DecisionAnswer]));
    refuses(send([{ id: 'MMR-q1', option: 0, verdict: 'overturn' }]));
    refuses(send([{ id: 'MMR-q1', option: 1.5, verdict: 'overturn' }]));
    refuses(send([{ id: 'MMR-q1', note: 4, verdict: 'confirm' } as unknown as DecisionAnswer]));
    refuses('nope');
  });

  test('leaves an overturn with no option or note to the Engine', () => {
    expect(() => parseAnswerDecisions(send([{ id: 'MMR-q1', verdict: 'overturn' }]))).not.toThrow();
  });
});
