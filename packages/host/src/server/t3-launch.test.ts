import { describe, expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import type { Engine } from '@mimir/contract';
import { parseSecretKey, sealSecret } from '@mimir/core';

import { createT3Adapter, T3_LAUNCH_TIMEOUT_MS, T3_SECRET_NAME } from './t3';
import type { T3AdapterOptions } from './t3';
import { parseT3LaunchInput } from './t3-input';
import { ATTEMPT_CAP, isLaunchBranch } from './t3-launch';
import type { T3Settings } from './t3-settings';
import type { T3LaunchField, T3LaunchResult, T3Unavailable } from './t3-states';
import { memorySecrets, STUB_ACCESS_TOKEN, STUB_LAUNCH_REFUSAL, stubT3 } from './t3-stub';
import type { StubOptions } from './t3-stub';

const T3 = 'https://t3.example';
const KEY = parseSecretKey(Buffer.alloc(32, 7).toString('base64'))!;
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const ready: T3Settings = {
  consoleUrl: 'https://mimir.example',
  enabled: true,
  key: KEY,
  problems: [],
  url: T3,
};

const codex = {
  displayName: 'Codex',
  models: [
    {
      id: 'gpt-6.1-sol',
      options: [
        { default: 'low', id: 'reasoningEffort', values: ['low', 'medium', 'high'] },
        { default: false, id: 'fastMode', values: [true, false] },
        { id: 'contextWindow' },
      ],
    },
  ],
  providerInstanceId: 'codex',
};
const claude = {
  displayName: 'Claude',
  models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1', options: [] }],
  providerInstanceId: 'claudeAgent',
  runtimeModes: ['approval-required', 'full-access'],
};
const grok = {
  constraints: ['Provider instance is disabled.'],
  displayName: 'Grok',
  models: [{ id: 'grok-5' }],
  providerInstanceId: 'grok',
};

/** The configured server (ceiling `auto`), a reachable peer, and peers that cannot be read. */
function world(change: Partial<StubOptions> = {}): StubOptions {
  return {
    configured: 'env-valhalla',
    environments: {
      'env-asgard': {
        label: 'asgard',
        projects: [{ id: 'p-asgard', remoteUrl: 'https://github.com/dbtlr/mimir', title: 'mimir' }],
        providers: [codex],
        runtimeMode: 'approval-required',
      },
      'env-broken': { failing: true, label: 'broken', projects: [] },
      'env-locked': { label: 'locked', projects: [], rejecting: true },
      'env-valhalla': {
        label: 'Valhalla',
        projects: [
          { id: 'p-mimir', remoteUrl: 'git@github.com:dbtlr/mimir.git', title: 'mimir' },
          { id: 'p-other', remoteUrl: 'git@github.com:dbtlr/other.git', title: 'other' },
        ],
        providers: [codex, claude, grok],
        runtimeMode: 'auto',
      },
    },
    links: [
      { environmentId: 'env-asgard', label: 'asgard', status: 'reachable' },
      { environmentId: 'env-mbp', label: 'DB MBP', status: 'unreachable' },
      { environmentId: 'env-broken', label: 'broken', status: 'reachable' },
      { environmentId: 'env-locked', label: 'locked', status: 'reachable' },
    ],
    origin: T3,
    ...change,
  };
}

type FakeTask = {
  id: string;
  type?: 'phase' | 'task';
  title: string;
  project: string;
  lifecycle: string;
  hold: string;
  harness: string | null;
  session: string | null;
  host: string | null;
  branch: string | null;
};

const todo = (id: string, project = 'MMR'): FakeTask => ({
  branch: null,
  harness: null,
  hold: 'none',
  host: null,
  id,
  lifecycle: 'todo',
  project,
  session: null,
  title: `Task ${id}`,
});

/**
 * An Engine with the two methods the launch uses. `queue` refuses as core
 * does; `refuseNext` makes the next queue throw, and `beforeQueue` lets a
 * test move the task first (the agent starting it).
 */
function fakeEngine(tasks: FakeTask[]) {
  const remotes: Record<string, string | null> = { BRF: null, MMR: 'github.com/dbtlr/mimir' };
  const nodes = new Map(tasks.map((task) => [task.id, task]));
  const queued: Record<string, unknown>[] = [];
  const control: { refuseNext?: Error; beforeQueue?: (task: FakeTask) => void; reads: number } = {
    reads: 0,
  };
  const engine = {
    getNode: async ({ id }: { id: string }) => {
      control.reads += 1;
      if (/^[A-Z]{2,4}$/.test(id)) {
        if (!(id in remotes)) {
          throw new MimirError('not_found', `${id} doesn't exist`);
        }
        return { id, remote: remotes[id], type: 'project' };
      }
      const node = nodes.get(id);
      if (node === undefined) {
        throw new MimirError('not_found', `${id} doesn't exist`);
      }
      const { project, ...view } = node;
      return { ...view, home: { projectKey: project }, type: node.type ?? 'task' };
    },
    queue: async (input: Record<string, unknown> & { id: string }) => {
      queued.push(input);
      const node = nodes.get(input.id);
      if (node === undefined) {
        throw new MimirError('not_found', `${input.id} doesn't exist`);
      }
      control.beforeQueue?.(node);
      const refusal = control.refuseNext;
      if (refusal !== undefined) {
        control.refuseNext = undefined;
        throw refusal;
      }
      if (node.lifecycle !== 'todo') {
        throw new MimirError('validation', `only a todo task can be queued (is ${node.lifecycle})`);
      }
      Object.assign(node, {
        branch: null,
        host: null,
        lifecycle: 'queued',
        ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'id')),
      });
      return node;
    },
  };
  return { control, engine: engine as unknown as Pick<Engine, 'getNode' | 'queue'>, nodes, queued };
}

/** A launch harness: a stub T3, a fake Engine, a sealed token, and a movable clock. */
function harness(
  options: {
    settings?: T3Settings;
    stub?: Partial<StubOptions>;
    tasks?: FakeTask[];
    connected?: boolean | 'expired';
  } & Partial<T3AdapterOptions> = {},
) {
  const stub = stubT3(world(options.stub));
  const secrets = memorySecrets();
  const fake = fakeEngine(
    options.tasks ?? [todo('MMR-1'), todo('MMR-2'), todo('BRF-1', 'BRF'), todo('ZZZ-1', 'ZZZ')],
  );
  const logs: string[] = [];
  const clock = { now: NOW };
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
  const adapter = createT3Adapter({
    clock: () => clock.now,
    engine: fake.engine,
    fetch: options.fetch ?? stub.fetch,
    log: (line) => logs.push(line),
    secrets,
    settings: options.settings ?? ready,
    timeoutMs: options.timeoutMs ?? 1000,
    version: '0.27.0',
    ...(options.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: options.launchTimeoutMs }),
  });
  const launch = (change: Record<string, unknown> = {}) =>
    adapter.launch(parseT3LaunchInput(choice(change)));
  return { adapter, clock, fake, launch, logs, secrets, stub };
}

/** A well-formed choice that Valhalla offers. */
function choice(change: Record<string, unknown> = {}) {
  return {
    attempt: 'attempt-0000000001',
    environmentId: 'env-valhalla',
    interactionMode: 'default',
    model: {
      instanceId: 'codex',
      model: 'gpt-6.1-sol',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    },
    projectId: 'p-mimir',
    runtimeMode: 'auto',
    task: 'MMR-1',
    workspace: { branch: 'mmr-1/launch', type: 'worktree' },
    ...change,
  };
}

const invalid = (field: T3LaunchField): T3LaunchResult => ({ field, state: 'invalid' });

/** An attempt id from a counter. */
const attemptNumber = (index: number) => `attempt-${String(index).padStart(10, '0')}`;

/** What a launch that should fault threw. */
async function thrown(launch: Promise<unknown>): Promise<unknown> {
  try {
    await launch;
  } catch (error) {
    return error;
  }
  throw new Error('the launch did not throw');
}

const launched = (threadId = 'thread-1'): T3LaunchResult => ({
  environmentId: 'env-valhalla',
  label: 'Valhalla',
  state: 'launched',
  threadId,
});

/** The tool names the stub was asked to call, in order. */
const calledTools = (h: ReturnType<typeof harness>) =>
  h.stub.requests
    .filter((request) => request.body.includes('tools/call'))
    .map((request) => JSON.parse(request.body).params.name as string);

describe('the launch input', () => {
  test('a malformed structure is a thrown validation error', () => {
    for (const bad of [
      { ...choice(), extra: true },
      choice({ attempt: 'short' }),
      choice({ attempt: 'has spaces in it, sixteen+' }),
      choice({ attempt: 'a'.repeat(65) }),
      choice({ runtimeMode: 'yolo' }),
      choice({ interactionMode: 'chat' }),
      choice({ workspace: { type: 'scratch' } }),
      choice({ workspace: { type: 'worktree', worktreePath: '/tmp' } }),
      choice({ model: { instanceId: 'codex', model: 'gpt-6.1-sol' } }),
      choice({ model: { ...choice().model, options: [{ id: 'x', value: { nested: 1 } }] } }),
      choice({ task: '' }),
    ]) {
      expect(() => parseT3LaunchInput(bad)).toThrow(MimirError);
    }
  });

  test('a well-formed choice the system may refuse is left for step 2', () => {
    expect(parseT3LaunchInput(choice({ workspace: { branch: 'x', type: 'root' } }))).toMatchObject({
      workspace: { branch: 'x', type: 'root' },
    });
    expect(
      parseT3LaunchInput(choice({ workspace: { branch: '-bad', type: 'worktree' } })),
    ).toBeDefined();
  });
});

describe('settings and the connection gate the launch', () => {
  test('unconfigured, misconfigured, and disconnected read as for the catalog, before T3 or the Engine', async () => {
    const cases: [Parameters<typeof harness>[0], T3Unavailable][] = [
      [{ settings: { enabled: false } }, { state: 'unconfigured' }],
      [
        { settings: { ...ready, problems: [{ problem: 'unset', setting: 'MIMIR_HOSTS' }] } },
        { problem: 'unset', setting: 'MIMIR_HOSTS', state: 'misconfigured' },
      ],
      [{ connected: false }, { reason: 'none', state: 'disconnected' }],
      [{ connected: 'expired' }, { reason: 'expired', state: 'disconnected' }],
      [
        { settings: { ...ready, url: 'https://t3-new.example' } },
        { reason: 'rejected', state: 'disconnected' },
      ],
    ];
    for (const [options, expected] of cases) {
      const h = harness(options);
      expect(await h.launch()).toEqual(expected);
      expect(h.stub.requests).toEqual([]);
      expect(h.fake.control.reads).toBe(0);
    }
  });

  test('a 401 from T3 reads disconnected rejected and launches nothing', async () => {
    const h = harness();
    h.stub.revokeToken();
    expect(await h.launch()).toEqual({ reason: 'rejected', state: 'disconnected' });
    expect(h.stub.launches).toEqual([]);
    expect(h.fake.queued).toEqual([]);
  });

  test('a T3 that does not answer reads unreachable', async () => {
    const h = harness({ fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    expect(await h.launch()).toEqual({ state: 'unreachable' });
    expect(h.fake.queued).toEqual([]);
  });
});

describe('step 1: the task', () => {
  test('a task queue would not accept reads not_ready without reaching T3', async () => {
    const h = harness({
      tasks: [
        { ...todo('MMR-3'), type: 'phase' },
        { ...todo('MMR-4'), lifecycle: 'done' },
        { ...todo('MMR-5'), lifecycle: 'abandoned' },
        { ...todo('MMR-6'), hold: 'parked' },
        { ...todo('MMR-7'), hold: 'blocked' },
        { ...todo('MMR-8'), harness: 't3', lifecycle: 'in_progress', session: 'thread-9' },
        { ...todo('MMR-9'), lifecycle: 'under_review' },
      ],
    });
    for (const task of ['MMR-3', 'MMR-4', 'MMR-5', 'MMR-6', 'MMR-7', 'MMR-8', 'MMR-9']) {
      expect(await h.launch({ task }), task).toEqual({ state: 'not_ready' });
    }
    expect(h.stub.requests).toEqual([]);
    expect(h.fake.queued).toEqual([]);
  });

  test('a task queued by someone else reads taken, naming its handles, without reaching T3', async () => {
    const h = harness({
      tasks: [
        {
          ...todo('MMR-1'),
          harness: 'claude',
          host: 'valhalla',
          lifecycle: 'queued',
          session: 'session-abc',
        },
      ],
    });
    expect(await h.launch()).toEqual({
      harness: 'claude',
      host: 'valhalla',
      session: 'session-abc',
      state: 'taken',
    });
    expect(h.stub.requests).toEqual([]);
  });

  test('a known attempt whose thread is the main session reads launched without reaching T3', async () => {
    const h = harness();
    expect(await h.launch()).toEqual(launched());
    const sent = h.stub.requests.length;
    expect(await h.launch()).toEqual(launched());
    // The agent has since started the task in that thread: still the same launch.
    Object.assign(h.fake.nodes.get('MMR-1')!, { lifecycle: 'in_progress' });
    expect(await h.launch()).toEqual(launched());
    expect(h.stub.requests).toHaveLength(sent);
    expect(h.stub.threads.size).toBe(1);
  });

  test('a known attempt whose task is now under review still reads launched without reaching T3', async () => {
    const h = harness();
    expect(await h.launch()).toEqual(launched());
    const sent = h.stub.requests.length;
    Object.assign(h.fake.nodes.get('MMR-1')!, { lifecycle: 'under_review' });
    expect(await h.launch()).toEqual(launched());
    expect(h.stub.requests).toHaveLength(sent);
  });

  test('a task the Engine does not know is its refusal, not a T3 state', async () => {
    const h = harness();
    const error = await thrown(h.launch({ task: 'MMR-404' }));
    expect(error).toBeInstanceOf(MimirError);
    expect((error as MimirError).message).toBe("MMR-404 doesn't exist");
  });
});

describe('the attempt registry', () => {
  test('a known attempt reused with another task reads invalid, before step 1', async () => {
    const h = harness({ tasks: [todo('MMR-1'), { ...todo('MMR-2'), lifecycle: 'done' }] });
    expect(await h.launch()).toEqual(launched());
    const sent = h.stub.requests.length;
    const reads = h.fake.control.reads;
    expect(await h.launch({ task: 'MMR-2' })).toEqual(invalid('attempt'));
    expect(h.stub.requests).toHaveLength(sent);
    expect(h.fake.control.reads).toBe(reads);
  });

  test.each([
    ['environmentId', { environmentId: 'env-asgard' }],
    ['projectId', { projectId: 'p-other' }],
    ['model.instanceId', { model: { ...choice().model, instanceId: 'claudeAgent' } }],
    ['model.model', { model: { ...choice().model, model: 'other-model' } }],
    [
      'an option value',
      { model: { ...choice().model, options: [{ id: 'reasoningEffort', value: 'low' }] } },
    ],
    ['runtimeMode', { runtimeMode: 'approval-required' }],
    ['interactionMode', { interactionMode: 'plan' }],
    ['workspace type', { workspace: { type: 'root' } }],
    ['workspace branch', { workspace: { branch: 'mmr-1/other', type: 'worktree' } }],
  ])(
    'a known attempt reused with another %s reads invalid attempt, with no launch',
    async (_name, change) => {
      const h = harness();
      // The first launch names no branch, so the type and the branch each change alone.
      const first = { workspace: { type: 'worktree' } };
      expect(await h.launch(first)).toEqual(launched());
      const launches = h.stub.launches.length;
      expect(await h.launch({ ...first, ...change })).toEqual(invalid('attempt'));
      expect(h.stub.launches).toHaveLength(launches);
    },
  );

  test('the same options in another order are the same choice', async () => {
    const options = [
      { id: 'reasoningEffort', value: 'high' },
      { id: 'fastMode', value: true },
    ];
    const h = harness();
    const model = { ...choice().model, options };
    expect(await h.launch({ model })).toEqual(launched());
    expect(await h.launch({ model: { ...model, options: options.toReversed() } })).toEqual(
      launched(),
    );
  });

  test('an attempt is forgotten after 24 hours', async () => {
    const h = harness({ stub: { launchReply: 'is_error' } });
    expect(await h.launch()).toEqual({ state: 'refused' });
    h.clock.now += DAY - 1;
    expect(await h.launch({ runtimeMode: 'approval-required' })).toEqual({
      field: 'attempt',
      state: 'invalid',
    });
    h.clock.now += 1;
    expect(await h.launch({ runtimeMode: 'approval-required' })).toEqual({ state: 'refused' });
  });

  test('a launched attempt past 24 hours reads taken, naming its own thread', async () => {
    const h = harness();
    expect(await h.launch()).toEqual(launched());
    h.clock.now += DAY;
    expect(await h.launch()).toEqual({
      harness: 't3',
      host: 'env-valhalla',
      session: 'thread-1',
      state: 'taken',
    });
  });

  test('at most 256 attempts are kept; a new one evicts the oldest', async () => {
    const h = harness({ stub: { launchReply: 'is_error' } });
    for (let index = 0; index <= ATTEMPT_CAP; index += 1) {
      expect(await h.launch({ attempt: attemptNumber(index) })).toEqual({ state: 'refused' });
    }
    const other = { runtimeMode: 'approval-required' };
    expect(await h.launch({ attempt: attemptNumber(0), ...other })).toEqual({ state: 'refused' });
    expect(await h.launch({ attempt: attemptNumber(2), ...other })).toEqual({
      field: 'attempt',
      state: 'invalid',
    });
  });
});

describe('one launch per task at a time', () => {
  test('two concurrent launches with different attempts make one thread; the other reads taken', async () => {
    const h = harness({ stub: { launchDelayMs: 20 } });
    const results = await Promise.all([
      h.launch({ attempt: 'attempt-aaaaaaaaaa' }),
      h.launch({ attempt: 'attempt-bbbbbbbbbb' }),
    ]);
    expect(results).toEqual([
      launched(),
      { harness: 't3', host: 'env-valhalla', session: 'thread-1', state: 'taken' },
    ]);
    expect(h.stub.launches).toHaveLength(1);
    expect(h.fake.queued).toHaveLength(1);
  });

  test('two concurrent launches of the same attempt both read launched, with one thread', async () => {
    const h = harness({ stub: { launchDelayMs: 20 } });
    expect(await Promise.all([h.launch(), h.launch()])).toEqual([launched(), launched()]);
    expect(h.stub.launches).toHaveLength(1);
  });

  test('two different tasks racing with the same attempt: one reaches T3, the other reads invalid attempt', async () => {
    const h = harness();
    const results = await Promise.all([h.launch(), h.launch({ task: 'MMR-2' })]);
    expect(results).toContainEqual(launched());
    expect(results).toContainEqual(invalid('attempt'));
    expect(h.stub.launches).toHaveLength(1);
    // The registry kept the first task's thread.
    const winner = results.findIndex((result) => result.state === 'launched');
    const task = winner === 0 ? 'MMR-1' : 'MMR-2';
    expect(await h.launch({ task })).toEqual(launched());
    expect(h.stub.launches).toHaveLength(1);
  });

  test('launches of different tasks do not wait on each other', async () => {
    const h = harness({ stub: { launchDelayMs: 20 } });
    const results = await Promise.all([
      h.launch(),
      h.launch({ attempt: 'attempt-bbbbbbbbbb', task: 'MMR-2' }),
    ]);
    expect(results.map((result) => result.state)).toEqual(['launched', 'launched']);
    expect(h.stub.threads.size).toBe(2);
  });
});

describe('step 2: the choice against the system', () => {
  test('each choice the system does not offer reads invalid, naming the field, and launches nothing', async () => {
    const model = choice().model;
    const cases: [Record<string, unknown>, T3LaunchField][] = [
      [{ environmentId: 'env-nowhere' }, 'environmentId'],
      [{ projectId: 'p-other' }, 'projectId'],
      [{ projectId: 'p-asgard' }, 'projectId'],
      [{ model: { ...model, instanceId: 'grok', model: 'grok-5' } }, 'model'],
      [{ model: { ...model, instanceId: 'nobody' } }, 'model'],
      [{ model: { ...model, model: 'gpt-5' } }, 'model'],
      [{ model: { ...model, options: [{ id: 'unknown', value: 'x' }] } }, 'options'],
      [
        {
          model: {
            ...model,
            options: [
              { id: 'reasoningEffort', value: 'low' },
              { id: 'reasoningEffort', value: 'low' },
            ],
          },
        },
        'options',
      ],
      [{ model: { ...model, options: [{ id: 'reasoningEffort', value: 'max' }] } }, 'options'],
      [{ model: { ...model, options: [{ id: 'fastMode', value: 'true' }] } }, 'options'],
      [{ model: { ...model, options: [{ id: 'contextWindow', value: 'large' }] } }, 'options'],
      [{ runtimeMode: 'full-access' }, 'runtimeMode'],
      [
        {
          model: { instanceId: 'claudeAgent', model: 'claude-fable-5-1', options: [] },
          runtimeMode: 'auto',
        },
        'runtimeMode',
      ],
      [{ workspace: { branch: 'mmr-1', type: 'root' } }, 'branch'],
      [{ workspace: { branch: '-x', type: 'worktree' } }, 'branch'],
    ];
    for (const [change, field] of cases) {
      const h = harness();
      expect(await h.launch(change), JSON.stringify(change)).toEqual(invalid(field));
      expect(h.stub.launches).toEqual([]);
      expect(h.fake.queued).toEqual([]);
    }
  });

  test('a peer is checked against its own catalog, under its own ceiling', async () => {
    const peer = { environmentId: 'env-asgard', projectId: 'p-asgard' };
    const h = harness();
    expect(await h.launch(peer)).toEqual(invalid('runtimeMode'));
    expect(
      await h.launch({ ...peer, attempt: 'attempt-0000000002', runtimeMode: 'approval-required' }),
    ).toEqual({
      environmentId: 'env-asgard',
      label: 'asgard',
      state: 'launched',
      threadId: 'thread-1',
    });
  });

  test('a project with no remote matches no T3 project', async () => {
    const h = harness();
    expect(await h.launch({ task: 'BRF-1' })).toEqual(invalid('projectId'));
    expect(h.stub.launches).toEqual([]);
  });

  test('a peer T3 lists unreachable, or whose reads fail, reads unreachable', async () => {
    for (const environmentId of ['env-mbp', 'env-broken']) {
      const h = harness();
      expect(await h.launch({ environmentId }), environmentId).toEqual({ state: 'unreachable' });
      expect(h.stub.launches).toEqual([]);
    }
  });

  test('a 401 on the chosen peer reads disconnected rejected', async () => {
    const h = harness();
    expect(await h.launch({ environmentId: 'env-locked' })).toEqual({
      reason: 'rejected',
      state: 'disconnected',
    });
    expect(h.stub.launches).toEqual([]);
  });

  test('the chosen system is read fresh on each launch', async () => {
    const h = harness();
    await h.launch({ task: 'MMR-1' });
    await h.launch({ attempt: 'attempt-0000000002', task: 'MMR-2' });
    expect(calledTools(h).filter((tool) => tool === 'orchestrator_capabilities')).toHaveLength(2);
  });
});

describe('the branch grammar', () => {
  test('accepts ordinary branch names', () => {
    for (const branch of ['main', 'mmr-625/launch', 'feature/a.b_c', 'v1.2', 'a'.repeat(200)]) {
      expect(isLaunchBranch(branch), branch).toBe(true);
    }
  });

  test('refuses every name the grammar rules out', () => {
    for (const branch of [
      '',
      'a'.repeat(201),
      'has space',
      'tilde~1',
      'caret^',
      'colon:',
      'star*',
      String.raw`back\slash`,
      '-leading',
      'HEAD',
      'a//b',
      '/leading',
      'trailing/',
      '.hidden',
      'a/.hidden',
      'ends.',
      'a/ends.',
      'ends.lock',
      'a.lock/b',
      'a..b',
      'a/b..c',
      'é',
    ]) {
      expect(isLaunchBranch(branch), branch).toBe(false);
    }
  });

  test('each refused name reads invalid naming branch in a launch', async () => {
    for (const branch of ['HEAD', 'a..b', 'x.lock', '.x', 'a//b']) {
      const h = harness();
      expect(await h.launch({ workspace: { branch, type: 'worktree' } }), branch).toEqual({
        field: 'branch',
        state: 'invalid',
      });
    }
  });
});

describe('step 3: the launch call', () => {
  test('carries exactly the checked choice, the title, the message, and the request id', async () => {
    const h = harness();
    expect(
      await h.launch({
        interactionMode: 'plan',
        model: {
          ...choice().model,
          options: [
            { id: 'reasoningEffort', value: 'high' },
            { id: 'fastMode', value: true },
          ],
        },
      }),
    ).toEqual(launched());
    expect(h.stub.launches).toEqual([
      {
        clientRequestId: 'mimir:MMR-1:attempt-0000000001',
        environmentId: 'env-valhalla',
        interactionMode: 'plan',
        message: 'Work MMR-1.',
        modelSelection: {
          instanceId: 'codex',
          model: 'gpt-6.1-sol',
          options: [
            { id: 'reasoningEffort', value: 'high' },
            { id: 'fastMode', value: true },
          ],
        },
        projectId: 'p-mimir',
        runtimeMode: 'auto',
        title: 'MMR-1 Task MMR-1',
        workspaceStrategy: { branch: 'mmr-1/launch', type: 'worktree' },
      },
    ]);
  });

  test('the workspace strategy is root, or a worktree with its branch only when one is named', async () => {
    const h = harness();
    await h.launch({ workspace: { type: 'root' } });
    await h.launch({
      attempt: 'attempt-0000000002',
      task: 'MMR-2',
      workspace: { type: 'worktree' },
    });
    expect(h.stub.launches.map((args) => args.workspaceStrategy)).toEqual([
      { type: 'root' },
      { type: 'worktree' },
    ]);
  });

  test('a tool error reads refused, without T3 text, and queues nothing', async () => {
    const h = harness({ stub: { launchReply: 'is_error' } });
    const result = await h.launch();
    expect(result).toEqual({ state: 'refused' });
    expect(JSON.stringify(result)).not.toContain('already exists');
    expect(h.fake.queued).toEqual([]);
  });

  test('a reply without a threadId reads unreachable and queues nothing', async () => {
    const h = harness({ stub: { launchReply: 'no_thread' } });
    expect(await h.launch()).toEqual({ state: 'unreachable' });
    expect(h.fake.queued).toEqual([]);
  });

  test('a launch tool T3 does not have reads refused, so Retry is not offered forever', async () => {
    const h = harness({ stub: { launchReply: 'unknown_tool' } });
    expect(await h.launch()).toEqual({ state: 'refused' });
    expect(h.fake.queued).toEqual([]);
  });

  test('a read tool T3 does not have, during a launch, reads unreachable and makes no launch call', async () => {
    for (const tool of ['t3_environment_read', 't3_project_list'] as const) {
      const h = harness({ stub: { missingTools: [tool] } });
      expect(await h.launch()).toEqual({ state: 'unreachable' });
      expect(h.stub.launches).toEqual([]);
    }
  });

  test("another tool's error during a launch reads unreachable and makes no launch call", async () => {
    const h = harness({ stub: { linksError: 'is_error' } });
    expect(await h.launch({ environmentId: 'env-asgard' })).toEqual({ state: 'unreachable' });
    expect(h.stub.launches).toEqual([]);
  });

  test('a lost reply, then a retry of the attempt, makes no second thread and ends launched', async () => {
    for (const lost of ['drop', 'hang'] as const) {
      const h = harness({ launchTimeoutMs: 30, stub: { launchReply: lost } });
      expect(await h.launch(), lost).toEqual({ state: 'unreachable' });
      expect(h.stub.threads.size).toBe(1);
      expect(h.fake.queued).toEqual([]);
      h.stub.setLaunchReply('answer');
      expect(await h.launch(), lost).toEqual(launched());
      expect(h.stub.threads.size).toBe(1);
      expect(h.stub.launches).toHaveLength(2);
    }
  });

  test('the launch call has its own timeout, longer than the reads', async () => {
    expect(T3_LAUNCH_TIMEOUT_MS).toBe(60_000);
    const h = harness({ launchTimeoutMs: 1000, stub: { launchDelayMs: 60 }, timeoutMs: 40 });
    expect(await h.launch()).toEqual(launched());
  });
});

describe('step 4: the queue', () => {
  test('queues the task for the thread: harness t3, the thread, the system, and the branch', async () => {
    const h = harness();
    expect(await h.launch()).toEqual(launched());
    expect(h.fake.queued).toEqual([
      {
        branch: 'mmr-1/launch',
        harness: 't3',
        host: 'env-valhalla',
        id: 'MMR-1',
        session: 'thread-1',
      },
    ]);
  });

  test('a workspace without a branch writes no branch', async () => {
    const h = harness();
    await h.launch({ workspace: { type: 'root' } });
    expect(h.fake.queued).toEqual([
      { harness: 't3', host: 'env-valhalla', id: 'MMR-1', session: 'thread-1' },
    ]);
  });

  test('a task the agent started first in this thread reads launched', async () => {
    const h = harness();
    h.fake.control.beforeQueue = (task) =>
      Object.assign(task, { harness: 't3', lifecycle: 'in_progress', session: 'thread-1' });
    expect(await h.launch()).toEqual(launched());
  });

  test('an Engine refusal reads not_queued with its message; a retry reaches the same thread', async () => {
    const h = harness();
    h.fake.control.refuseNext = new MimirError('conflict', 'the store is busy');
    expect(await h.launch()).toEqual({
      environmentId: 'env-valhalla',
      label: 'Valhalla',
      message: 'the store is busy',
      state: 'not_queued',
      threadId: 'thread-1',
    });
    expect(await h.launch()).toEqual(launched());
    expect(h.stub.threads.size).toBe(1);
    expect(h.fake.queued).toHaveLength(2);
  });

  test('a task that can no longer be read after a refusal reads not_queued with the refusal', async () => {
    const h = harness();
    h.fake.control.beforeQueue = (task) => {
      h.fake.nodes.delete(task.id);
    };
    h.fake.control.refuseNext = new MimirError('conflict', 'the store is busy');
    expect(await h.launch()).toEqual({
      environmentId: 'env-valhalla',
      label: 'Valhalla',
      message: 'the store is busy',
      state: 'not_queued',
      threadId: 'thread-1',
    });
  });

  test('a not_queued retry whose task another session has since queued reads taken', async () => {
    const h = harness();
    h.fake.control.refuseNext = new MimirError('conflict', 'the store is busy');
    expect((await h.launch()).state).toBe('not_queued');
    Object.assign(h.fake.nodes.get('MMR-1')!, {
      harness: 'claude',
      host: null,
      lifecycle: 'queued',
      session: 'other',
    });
    expect(await h.launch()).toEqual({
      harness: 'claude',
      host: null,
      session: 'other',
      state: 'taken',
    });
  });

  test('a fault that is not an Engine refusal rethrows', async () => {
    const h = harness();
    h.fake.control.refuseNext = new Error('disk on fire');
    expect(await thrown(h.launch())).toEqual(new Error('disk on fire'));
  });
});

describe('Open in T3', () => {
  test('the origin is MIMIR_T3_URL when configured, read without a secret or a request', async () => {
    const fetched: string[] = [];
    const h = harness({
      fetch: async (input) => {
        fetched.push(input);
        throw new TypeError('no requests');
      },
    });
    h.secrets.read = async () => {
      throw new Error('no secret reads');
    };
    expect(h.adapter.origin()).toEqual({ origin: T3 });
    expect(fetched).toEqual([]);
  });

  test('the origin is null when the feature is unconfigured', () => {
    expect(harness({ settings: { enabled: false } }).adapter.origin()).toEqual({ origin: null });
  });
});

test('no token or T3 reply body appears in any launch log line', async () => {
  const runs = [
    harness({ stub: { launchReply: 'is_error' } }),
    harness({ stub: { launchReply: 'no_thread' } }),
    harness({ launchTimeoutMs: 20, stub: { launchReply: 'hang' } }),
    harness({ stub: { launchReply: 'drop' } }),
    harness(),
  ];
  for (const run of runs) {
    await run.launch();
    await run.launch({ attempt: 'attempt-0000000002', environmentId: 'env-broken' });
  }
  const revoked = harness();
  revoked.stub.revokeToken();
  await revoked.launch();
  const lines = [...runs, revoked].flatMap((run) => run.logs);
  expect(lines.length).toBeGreaterThan(0);
  const logs = lines.join('\n');
  for (const secret of [
    STUB_ACCESS_TOKEN,
    STUB_LAUNCH_REFUSAL,
    'environment unavailable',
    'unauthorized',
    'Work MMR-1',
    't3-thread://',
  ]) {
    expect(logs).not.toContain(secret);
  }
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(
      Object.keys(entry).every((key) =>
        ['endpoint', 'event', 'status', 'time', 'tool', 'method'].includes(key),
      ),
      line,
    ).toBe(true);
  }
});
