import { describe, expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  LocalEngine,
  parseSecretKey,
  sealSecret,
} from '@mimir/core';
import { createTestStore } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { createT3Adapter, T3_SECRET_NAME } from './t3';
import type { T3AdapterOptions } from './t3';
import type { T3Settings } from './t3-settings';
import { T3_WAKE_ACTIONS } from './t3-states';
import type { T3WakeAction, T3WakeField, T3WakeInput, T3WakeState } from './t3-states';
import { memorySecrets, STUB_ACCESS_TOKEN, STUB_WAKE_REFUSAL, stubT3 } from './t3-stub';
import type { StubLaunchReply } from './t3-stub';
import {
  decisionTarget,
  deliveryTarget,
  parseWakeInput,
  sinceBefore,
  wakeMessage,
} from './t3-wake';

const T3 = 'https://t3.example';
const KEY = parseSecretKey(Buffer.alloc(32, 7).toString('base64'))!;
const NOW = Date.parse('2026-11-16T09:10:02.311Z');
const DAY = 24 * 60 * 60 * 1000;
const ATTEMPT = 'attempt-0000000001';
const SINCE = '2026-11-16T09:10:02.310Z';

const ready: T3Settings = {
  consoleUrl: 'https://mimir.example',
  enabled: true,
  key: KEY,
  problems: [],
  url: T3,
};

type FakeDelivery = {
  id: string;
  harness: string | null;
  host: string | null;
  session: string | null;
};
const T3_DELIVERY: FakeDelivery = {
  harness: 't3',
  host: 'env-valhalla',
  id: 'MMR-d3',
  session: 'thread-9',
};

/** An Engine with the reads the wake makes; `fault` makes the delivery read throw. */
function fakeEngine(deliveries: FakeDelivery[], decisions: Record<string, string | null> = {}) {
  const control: { fault?: Error; reads: string[] } = { reads: [] };
  const engine = {
    getDecision: async ({ id }: { id: string }) => {
      if (!(id in decisions)) {
        throw new MimirError('not_found', `${id} doesn't exist`);
      }
      return { delivery: decisions[id], id };
    },
    getDelivery: async ({ id }: { id: string }) => {
      control.reads.push(id);
      if (control.fault !== undefined) {
        throw control.fault;
      }
      const found = deliveries.find((delivery) => delivery.id === id);
      if (found === undefined) {
        throw new MimirError('not_found', `${id} doesn't exist`);
      }
      return found;
    },
  };
  return {
    control,
    engine: engine as unknown as T3AdapterOptions['engine'],
  };
}

function harness(
  options: {
    settings?: T3Settings;
    connected?: boolean | 'expired';
    deliveries?: FakeDelivery[];
    decisions?: Record<string, string | null>;
    wakeReply?: StubLaunchReply;
    timeoutMs?: number;
  } = {},
) {
  const stub = stubT3({
    configured: 'env-valhalla',
    environments: { 'env-valhalla': { label: 'Valhalla', projects: [] } },
    origin: T3,
    ...(options.wakeReply === undefined ? {} : { wakeReply: options.wakeReply }),
  });
  const secrets = memorySecrets();
  let secretReads = 0;
  const read = secrets.read;
  secrets.read = async (name) => {
    secretReads += 1;
    return read(name);
  };
  if (options.connected !== false) {
    const expiresAt = options.connected === 'expired' ? NOW - 1 : NOW + 30 * DAY;
    secrets.rows.set(
      T3_SECRET_NAME,
      sealSecret(
        KEY,
        T3_SECRET_NAME,
        JSON.stringify({
          accessToken: STUB_ACCESS_TOKEN,
          expiresAt: new Date(expiresAt).toISOString(),
          issuer: T3,
        }),
      ),
    );
  }
  const fake = fakeEngine(
    options.deliveries ?? [T3_DELIVERY],
    options.decisions ?? { 'MMR-q4': 'MMR-d3' },
  );
  const logs: string[] = [];
  const adapter = createT3Adapter({
    clock: () => NOW,
    engine: fake.engine,
    fetch: stub.fetch,
    log: (line) => logs.push(line),
    secrets,
    settings: options.settings ?? ready,
    timeoutMs: options.timeoutMs ?? 1000,
    version: '0.27.0',
  });
  /** The wake after a committed write of `action`. */
  const wake = (action: T3WakeAction = 'deliveryPark', delivery: string | null = 'MMR-d3') =>
    adapter.writeAndWake(
      action,
      ATTEMPT,
      async () => {
        committed.count += 1;
        return { delivery, id: action === 'overturn' ? 'MMR-q4' : (delivery ?? '') };
      },
      action === 'overturn' ? decisionTarget : deliveryTarget,
    );
  const committed = { count: 0 };
  return { adapter, committed, fake, logs, secretReads: () => secretReads, secrets, stub, wake };
}

const retryFor = (action: T3WakeAction = 'deliveryPark'): T3WakeInput => ({
  action,
  attempt: ATTEMPT,
  decision: action === 'overturn' ? 'MMR-q4' : null,
  delivery: 'MMR-d3',
  since: SINCE,
});

describe('the wake message', () => {
  test('each action has its fixed phrase, naming only ids', () => {
    const phrases: Record<T3WakeAction, string> = {
      answerDecisions: 'answered decisions on delivery MMR-d3',
      deliveryAbandon: 'abandoned delivery MMR-d3',
      deliveryPark: 'paused delivery MMR-d3',
      deliveryReturn: 'sent back the milestone of delivery MMR-d3',
      deliveryUnblock: 'cleared the stop on delivery MMR-d3',
      deliveryUnpark: 'resumed delivery MMR-d3',
      deliveryUpdate: 'edited delivery MMR-d3',
      overturn: 'overturned decision MMR-q4 on delivery MMR-d3',
    };
    expect(Object.keys(phrases).toSorted()).toEqual([...T3_WAKE_ACTIONS].toSorted());
    for (const action of T3_WAKE_ACTIONS) {
      const { attempt: _attempt, ...input } = retryFor(action);
      expect(wakeMessage(input)).toBe(
        `Mimir: the operator ${phrases[action]}. Read what changed: mimir get MMR-d3 --since ${SINCE}`,
      );
    }
  });

  test('the since is one millisecond before the clock', () => {
    expect(sinceBefore(NOW)).toBe(SINCE);
  });
});

describe('the wake send', () => {
  test('a delivery action sends one message to its thread', async () => {
    const h = harness();
    const woken = await h.wake('deliveryUnblock');
    expect(woken.wake).toEqual({ state: 'sent' });
    expect(h.stub.wakes).toEqual([
      {
        clientRequestId: `mimir:wake:${ATTEMPT}`,
        environmentId: 'env-valhalla',
        message: `Mimir: the operator cleared the stop on delivery MMR-d3. Read what changed: mimir get MMR-d3 --since ${SINCE}`,
        mode: 'auto',
        threadId: 'thread-9',
      },
    ]);
  });

  test('an overturn names its decision and the decision’s delivery', async () => {
    const h = harness();
    expect((await h.wake('overturn')).wake).toEqual({ state: 'sent' });
    expect(h.stub.wakes).toHaveLength(1);
    expect(h.stub.wakes[0]?.message).toContain('overturned decision MMR-q4 on delivery MMR-d3.');
  });

  test('an update that changed the handles wakes the thread the write left', async () => {
    const h = harness({
      deliveries: [{ ...T3_DELIVERY, host: 'env-asgard', session: 'thread-new' }],
    });
    await h.wake('deliveryUpdate');
    expect(h.stub.wakes[0]).toMatchObject({ environmentId: 'env-asgard', threadId: 'thread-new' });
  });

  test('the since read from the message shows the action', async () => {
    const fixture: TestStore = await createTestStore();
    try {
      const { store } = fixture;
      await createProject(store, { key: 'SNC', name: 'Since' });
      const initiative = await createInitiative(store, { projectId: 'SNC', title: 'Plan' });
      const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase' });
      const task = await createTask(store, { parentId: phase.id, title: 'A' });
      const engine = new LocalEngine(store);
      const created = await engine.deliveryCreate({
        agreement: 'Ship it',
        harness: 't3',
        host: 'env-valhalla',
        phase: phase.id,
        session: 'thread-9',
        tasks: [task.id],
        title: 'Attempt',
      });
      await engine.deliveryStart({ id: created.id });
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
            expiresAt: new Date(Date.now() + DAY).toISOString(),
            issuer: T3,
          }),
        ),
      );
      const adapter = createT3Adapter({
        engine,
        fetch: stub.fetch,
        log: () => {},
        secrets,
        settings: ready,
        version: '0.27.0',
      });
      await adapter.writeAndWake(
        'deliveryPark',
        ATTEMPT,
        () => engine.deliveryPark({ id: created.id, reason: 'pausing' }),
        deliveryTarget,
      );
      const message = String(stub.wakes[0]?.message);
      const since = new Date(/--since (\S+)$/.exec(message)?.[1] ?? '');
      const { events } = await engine.deliverySince({ id: created.id, since });
      expect(events.some((event) => event.kind === 'hold' && event.to === 'paused')).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

describe('who receives the wake', () => {
  test.each([
    ['another harness', { ...T3_DELIVERY, harness: 'codex' }],
    ['no harness', { ...T3_DELIVERY, harness: null }],
    ['a blank session', { ...T3_DELIVERY, session: '  ' }],
    ['no host', { ...T3_DELIVERY, host: null }],
  ])('a delivery with %s is skipped without reading the secret', async (_name, delivery) => {
    const h = harness({ deliveries: [delivery] });
    expect((await h.wake()).wake).toEqual({ reason: 'no_thread', state: 'skipped' });
    expect(h.secretReads()).toBe(0);
    expect(h.stub.wakes).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test('an overturn of a decision with no delivery is skipped no_delivery', async () => {
    const h = harness();
    expect((await h.wake('overturn', null)).wake).toEqual({
      reason: 'no_delivery',
      state: 'skipped',
    });
    expect(h.fake.control.reads).toEqual([]);
  });

  test('the feature unset is skipped unconfigured, with nothing read', async () => {
    const h = harness({ settings: { enabled: false } });
    expect((await h.wake()).wake).toEqual({ reason: 'unconfigured', state: 'skipped' });
    expect(h.fake.control.reads).toEqual([]);
    expect(h.secretReads()).toBe(0);
  });

  test('a bad setting reads misconfigured for a T3 delivery, and skips for another harness', async () => {
    const settings: T3Settings = {
      ...ready,
      key: undefined,
      problems: [{ problem: 'missing', setting: 'MIMIR_SECRET_KEY' }],
    };
    const due = harness({ settings });
    expect((await due.wake()).wake).toEqual({
      problem: 'missing',
      setting: 'MIMIR_SECRET_KEY',
      state: 'misconfigured',
    });
    const other = harness({ deliveries: [{ ...T3_DELIVERY, harness: 'codex' }], settings });
    expect((await other.wake()).wake).toEqual({ reason: 'no_thread', state: 'skipped' });
  });

  test.each<['none' | 'expired', { connected: false | 'expired' }]>([
    ['none', { connected: false }],
    ['expired', { connected: 'expired' }],
  ])('no usable token (%s) reads disconnected for a T3 delivery', async (reason, options) => {
    const h = harness(options);
    expect((await h.wake()).wake).toEqual({ reason, state: 'disconnected' });
    expect(h.stub.wakes).toEqual([]);
  });

  test('a token T3 rejects reads disconnected rejected', async () => {
    const h = harness();
    h.stub.revokeToken();
    expect((await h.wake()).wake).toEqual({ reason: 'rejected', state: 'disconnected' });
  });
});

describe('a failed wake leaves the write', () => {
  test.each([
    ['is_error', 'refused'],
    ['unknown_tool', 'refused'],
    ['drop', 'unreachable'],
    ['hang', 'unreachable'],
  ] as const)('a send T3 answers %s reads %s', async (wakeReply, state) => {
    const h = harness({ timeoutMs: 100, wakeReply });
    const woken = await h.wake('deliveryAbandon');
    expect(h.committed.count).toBe(1);
    expect(woken.record).toMatchObject({ id: 'MMR-d3' });
    expect(woken.wake).toEqual(
      state === 'refused'
        ? { state, thread: { host: 'env-valhalla', session: 'thread-9' } }
        : { retry: { ...retryFor('deliveryAbandon'), since: SINCE }, state },
    );
    expect(h.logs.join('\n')).not.toContain(STUB_WAKE_REFUSAL);
  });

  test('an Engine fault in the delivery read answers failed with its retry', async () => {
    const h = harness();
    h.fake.control.fault = new Error('database is locked: secret detail');
    const woken = await h.wake();
    expect(h.committed.count).toBe(1);
    expect(woken.wake).toEqual({ retry: retryFor(), state: 'failed' });
    expect(h.logs).toHaveLength(1);
    expect(JSON.parse(h.logs[0] ?? '')).toMatchObject({
      delivery: 'MMR-d3',
      event: 't3_wake_fault',
    });
    expect(h.logs.join('\n')).not.toContain('secret detail');
  });

  test('a refused write sends nothing and throws as the write did', async () => {
    const h = harness();
    const refusal = new MimirError('validation', 'cannot park');
    expect(
      h.adapter.writeAndWake(
        'deliveryPark',
        ATTEMPT,
        async () => Promise.reject(refusal),
        deliveryTarget,
      ),
    ).rejects.toBe(refusal);
    expect(h.stub.wakes).toEqual([]);
  });
});

describe('wakeT3', () => {
  test('a retry resends under the same request id', async () => {
    const h = harness({ wakeReply: 'drop' });
    const first = await h.wake();
    expect(first.wake.state).toBe('unreachable');
    h.stub.setWakeReply('answer');
    const retry = (first.wake as Extract<T3WakeState, { state: 'unreachable' }>).retry;
    expect(await h.adapter.wakeT3(retry)).toEqual({ state: 'sent' });
    expect(h.stub.wakes).toHaveLength(2);
    expect(h.stub.wakes[1]).toEqual(h.stub.wakes[0]);
  });

  test('a retry of an overturn checks the decision against the delivery', async () => {
    const h = harness({ decisions: { 'MMR-q4': 'MMR-d3', 'MMR-q5': 'MMR-d7', 'MMR-q6': null } });
    expect(await h.adapter.wakeT3(retryFor('overturn'))).toEqual({ state: 'sent' });
    for (const decision of ['MMR-q5', 'MMR-q6', 'MMR-q99']) {
      expect(await h.adapter.wakeT3({ ...retryFor('overturn'), decision })).toEqual({
        field: 'decision',
        state: 'invalid',
      });
    }
    expect(h.stub.wakes).toHaveLength(1);
  });

  test('a retry of an overturn with the feature unset skips before reading the decision', async () => {
    const h = harness({ decisions: {}, settings: { enabled: false } });
    expect(await h.adapter.wakeT3(retryFor('overturn'))).toEqual({
      reason: 'unconfigured',
      state: 'skipped',
    });
    expect(h.logs).toEqual([]);
  });

  test.each<[T3WakeField, Record<string, unknown>]>([
    ['action', { action: 'deliveryLand' }],
    ['delivery', { delivery: 'MMR-3' }],
    ['decision', { decision: 'MMR-q4' }],
    ['attempt', { attempt: 'short' }],
    ['since', { since: '2026-11-16T09:10:02Z' }],
    ['since', { since: '0099-01-01T00:00:00.000Z' }],
    ['since', { since: '2026-02-30T00:00:00.000Z' }],
  ])('a bad %s reads invalid and sends nothing', async (field, change) => {
    const h = harness();
    expect(await h.adapter.wakeT3({ ...retryFor(), ...change })).toEqual({
      field,
      state: 'invalid',
    });
    expect(h.stub.wakes).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test('an input that is no object of these keys is a thrown validation error', () => {
    expect(() => parseWakeInput({ ...retryFor(), extra: 1 })).toThrow(MimirError);
    expect(() => parseWakeInput('nope')).toThrow(MimirError);
  });
});

describe('the wake log', () => {
  test('a sent wake logs its outcome and delivery, never the message', async () => {
    const h = harness();
    await h.wake();
    expect(h.logs).toHaveLength(1);
    expect(JSON.parse(h.logs[0] ?? '')).toMatchObject({
      delivery: 'MMR-d3',
      event: 't3_wake',
      outcome: 'sent',
    });
    expect(h.logs.join('\n')).not.toContain('Mimir: the operator');
  });

  test('a refused wake logs refused, without T3’s words', async () => {
    const h = harness({ wakeReply: 'is_error' });
    await h.wake();
    expect(JSON.parse(h.logs.at(-1) ?? '')).toMatchObject({ event: 't3_wake', outcome: 'refused' });
    expect(h.logs.join('\n')).not.toContain(STUB_WAKE_REFUSAL);
  });
});
