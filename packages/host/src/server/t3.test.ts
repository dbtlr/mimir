import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';

import type { Engine } from '@mimir/contract';
import { openSecret, parseSecretKey, sealSecret } from '@mimir/core';
import type { SecretKey } from '@mimir/core';

import { createT3Adapter, T3_SECRET_NAME } from './t3';
import type { T3AdapterOptions } from './t3';
import type { T3Settings } from './t3-settings';
import type { T3Unavailable } from './t3-states';
import { memorySecrets, STUB_ACCESS_TOKEN, stubT3 } from './t3-stub';
import type { StubOptions } from './t3-stub';

const T3 = 'https://t3.example';
const CONSOLE = 'https://mimir.example';
const KEY_TEXT = Buffer.alloc(32, 7).toString('base64');
const KEY = parseSecretKey(KEY_TEXT)!;
const DAY = 24 * 60 * 60 * 1000;

const ready: T3Settings = {
  consoleUrl: CONSOLE,
  enabled: true,
  key: KEY,
  problems: [],
  url: T3,
};

const codex = {
  constraints: [],
  displayName: 'Codex',
  driverKind: 'codex',
  models: [
    {
      id: 'gpt-6.1-sol',
      options: [{ default: 'low', id: 'reasoningEffort', values: ['low', 'medium', 'high'] }],
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
  runtimeModes: ['approval-required', 'auto', 'full-access'],
};

/** A T3 world: the configured server, three peers, and every catalog edge on them. */
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
      'env-empty': {
        label: 'empty',
        projects: [{ id: 'p-other', remoteUrl: 'git@github.com:dbtlr/other.git', title: 'other' }],
      },
      'env-valhalla': {
        defaultThreadEnvMode: 'worktree',
        label: 'Valhalla',
        projects: [
          { id: 'p-briefs', title: 'briefs' },
          {
            defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' },
            id: 'p-mimir',
            remoteUrl: 'git@github.com:dbtlr/mimir.git',
            title: 'mimir',
          },
          { id: 'p-other', remoteUrl: 'git@github.com:dbtlr/other.git', title: 'other' },
          {
            id: 'p-mimir-https',
            remoteUrl: 'https://github.com/dbtlr/mimir.git/',
            title: 'mimir (copy)',
          },
        ],
        providers: [codex, claude, grok],
        runtimeMode: 'auto',
      },
    },
    links: [
      { environmentId: 'env-valhalla', label: 'Valhalla', status: 'reachable' },
      { environmentId: 'env-mbp', label: 'DB MBP', status: 'unreachable' },
      { environmentId: 'env-asgard', label: 'asgard', status: 'reachable' },
      { environmentId: 'env-broken', label: 'broken', status: 'reachable' },
      { environmentId: 'env-empty', label: 'empty', status: 'reachable' },
    ],
    origin: T3,
    ...change,
  };
}

const remotes: Record<string, string | null> = { BRF: null, MMR: 'github.com/dbtlr/mimir' };
const engine = {
  getNode: async ({ id }: { id: string }) => ({ id, remote: remotes[id] ?? null }),
} as unknown as Pick<Engine, 'getNode' | 'queue'>;

/** An adapter over a stub T3, with its logs, secrets, requests, and a movable clock. */
function harness(
  options: { settings?: T3Settings; stub?: Partial<StubOptions> } & Partial<T3AdapterOptions> = {},
) {
  const stub = stubT3(world(options.stub));
  const secrets = options.secrets ?? memorySecrets();
  const logs: string[] = [];
  const clock = { now: Date.parse('2026-11-03T12:00:00.000Z') };
  const adapter = createT3Adapter({
    clock: () => clock.now,
    engine,
    fetch: stub.fetch,
    log: (line) => logs.push(line),
    secrets,
    settings: options.settings ?? ready,
    timeoutMs: options.timeoutMs ?? 1000,
    version: '0.27.0',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return { adapter, clock, logs, secrets: secrets as ReturnType<typeof memorySecrets>, stub };
}

/** Every callback answer is an uncached redirect that sends no referrer onward. */
function expectCallbackRedirect(response: Response) {
  expect(response.status).toBe(303);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

/** Run Connect and the callback through to a sealed token. */
async function connected(h: ReturnType<typeof harness>) {
  const started = await h.adapter.connect(CONSOLE);
  if (started.state !== 'authorize') {
    throw new Error(`connect answered ${started.state}`);
  }
  const response = await h.adapter.callback(new Request(h.stub.approve(started.url)));
  expectCallbackRedirect(response);
  expect(response.headers.get('location')).toBe('/devices?t3=connected');
  return started.url;
}

/** The redirect reason a callback answered. */
async function callbackReason(h: ReturnType<typeof harness>, url: string) {
  const response = await h.adapter.callback(new Request(url));
  expectCallbackRedirect(response);
  return response.headers.get('location');
}

/** Run Connect and answer the reason its approved callback redirects with. */
async function approvedReason(h: ReturnType<typeof harness>) {
  const started = await h.adapter.connect(CONSOLE);
  if (started.state !== 'authorize') {
    throw new Error('expected an authorization URL');
  }
  return callbackReason(h, h.stub.approve(started.url));
}

/** The `environmentId` of every tool call the stub received. */
function calledEnvironments(h: ReturnType<typeof harness>, tool: string) {
  return h.stub.requests
    .filter((request) => request.body.includes(`"name":"${tool}"`))
    .map((request) => JSON.parse(request.body).params.arguments.environmentId);
}

describe('settings gate the feature', () => {
  test('with MIMIR_T3_URL unset the feature is absent and nothing reaches T3', async () => {
    const h = harness({ settings: { enabled: false } });
    expect(await h.adapter.status(CONSOLE)).toEqual({ state: 'unconfigured' });
    expect(await h.adapter.catalog('MMR')).toEqual({ state: 'unconfigured' });
    expect(await h.adapter.connect(CONSOLE)).toEqual({ state: 'unconfigured' });
    expect(await callbackReason(h, `${CONSOLE}/auth/t3/callback?state=x`)).toBe(
      '/devices?t3=misconfigured',
    );
    expect(h.stub.requests).toEqual([]);
  });

  test('each misconfiguration reads misconfigured naming its setting, before any request', async () => {
    for (const problem of [
      { problem: 'malformed', setting: 'MIMIR_T3_URL' },
      { problem: 'unset', setting: 'MIMIR_HOSTS' },
      { problem: 'missing', setting: 'MIMIR_SECRET_KEY' },
      { problem: 'unreadable', setting: 'MIMIR_SECRET_KEY_FILE' },
      { problem: 'not HTTPS', setting: 'MIMIR_URL' },
    ] as const) {
      const h = harness({ settings: { ...ready, problems: [problem] } });
      const expected: T3Unavailable = { state: 'misconfigured', ...problem };
      expect(await h.adapter.status(CONSOLE)).toEqual(expected);
      expect(await h.adapter.catalog('MMR')).toEqual(expected);
      expect(await h.adapter.connect(CONSOLE)).toEqual(expected);
      expect(h.stub.requests).toEqual([]);
    }
  });

  test('Connect without a usable key refuses before sending the browser anywhere, and writes nothing', async () => {
    const h = harness({
      settings: {
        ...ready,
        key: undefined,
        problems: [{ problem: 'malformed', setting: 'MIMIR_SECRET_KEY' }],
      },
    });
    const answer = await h.adapter.connect(CONSOLE);
    expect(answer).toEqual({
      problem: 'malformed',
      setting: 'MIMIR_SECRET_KEY',
      state: 'misconfigured',
    });
    expect('url' in answer).toBe(false);
    expect(h.stub.requests).toEqual([]);
    expect(h.secrets.writes).toBe(0);
  });

  test('without MIMIR_URL only a loopback request origin can receive the redirect', async () => {
    const h = harness({ settings: { ...ready, consoleUrl: undefined } });
    const unset: T3Unavailable = { problem: 'unset', setting: 'MIMIR_URL', state: 'misconfigured' };
    expect(await h.adapter.connect('https://console.tailnet.example')).toEqual(unset);
    expect(await h.adapter.status('https://console.tailnet.example')).toEqual(unset);
    expect(h.stub.requests).toEqual([]);
    const started = await h.adapter.connect('http://localhost:64647');
    expect(started.state).toBe('authorize');
    if (started.state === 'authorize') {
      expect(new URL(started.url).searchParams.get('redirect_uri')).toBe(
        'http://localhost:64647/auth/t3/callback',
      );
    }
    expect(await h.adapter.status('http://127.0.0.1:64647')).toEqual({
      reason: 'none',
      state: 'disconnected',
    });
  });
});

describe('Connect pins the issuer', () => {
  test.each([
    ['a different issuer', { issuer: 'https://evil.example' }, 2],
    ['an endpoint on another origin', { endpointOrigin: 'https://evil.example' }, 2],
    ['a different resource', { resource: 'https://evil.example/mcp' }, 1],
    ['another authorization server too', { authorizationServers: [T3, 'https://evil.example'] }, 1],
    ['a redirected metadata reply', { redirectMetadata: true }, 1],
    ['a failed registration', { registrationStatus: 400 }, 3],
  ] as const)('%s reads unreachable and stops there', async (_name, change, sent) => {
    const h = harness({ stub: change });
    expect(await h.adapter.connect(CONSOLE)).toEqual({ state: 'unreachable' });
    expect(h.stub.requests).toHaveLength(sent);
    expect(h.stub.requests.every((request) => request.url.startsWith(T3))).toBe(true);
    expect(h.secrets.writes).toBe(0);
  });

  test('a T3 that does not answer in time reads unreachable', async () => {
    const h = harness({
      // A server that never answers: the request ends only when its timeout aborts it.
      fetch: async (_input, init) => {
        await once(init.signal ?? new EventTarget(), 'abort');
        throw new Error('aborted');
      },
      timeoutMs: 20,
    });
    expect(await h.adapter.connect(CONSOLE)).toEqual({ state: 'unreachable' });
  });

  test('the authorization URL carries PKCE S256, the state, the resource, and both scopes', async () => {
    const h = harness();
    const started = await h.adapter.connect(CONSOLE);
    if (started.state !== 'authorize') {
      throw new Error('expected an authorization URL');
    }
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(`${T3}/oauth/mcp/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: `client-for:${CONSOLE}/auth/t3/callback`,
      code_challenge_method: 'S256',
      redirect_uri: `${CONSOLE}/auth/t3/callback`,
      resource: `${T3}/mcp`,
      response_type: 'code',
      scope: 'orchestration:read orchestration:operate',
    });
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    const registration = JSON.parse(h.stub.requests[2]?.body ?? '{}');
    expect(registration).toEqual({
      client_name: 'Mimir',
      grant_types: ['authorization_code'],
      redirect_uris: [`${CONSOLE}/auth/t3/callback`],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(h.secrets.writes).toBe(0);
  });
});

describe('the callback', () => {
  test('a full round trip seals the token, its expiry, and the issuer as t3.oauth', async () => {
    const h = harness();
    await connected(h);
    expect(h.secrets.writes).toBe(1);
    const sealed = h.secrets.rows.get(T3_SECRET_NAME) ?? '';
    expect(sealed).toStartWith('v1.');
    expect(sealed).not.toContain(STUB_ACCESS_TOKEN);
    expect(JSON.parse(openSecret(KEY, T3_SECRET_NAME, sealed) ?? '{}')).toEqual({
      accessToken: STUB_ACCESS_TOKEN,
      expiresAt: new Date(h.clock.now + 30 * DAY).toISOString(),
      issuer: T3,
    });
    expect(await h.adapter.status(CONSOLE)).toEqual({
      expiresAt: '2026-12-03T12:00:00.000Z',
      label: 'Valhalla',
      state: 'connected',
    });
  });

  test('a grant without a scope field is read as the requested scopes', async () => {
    const h = harness({ stub: { grantedScope: null } });
    await connected(h);
    expect(h.secrets.writes).toBe(1);
  });

  test('refused callbacks answer their reason and write nothing', async () => {
    const h = harness();
    const start = async () => {
      const started = await h.adapter.connect(CONSOLE);
      if (started.state !== 'authorize') {
        throw new Error('expected an authorization URL');
      }
      return started.url;
    };
    expect(await callbackReason(h, h.stub.approve(await start(), { state: 'unknown' }))).toBe(
      '/devices?t3=stale',
    );
    expect(await callbackReason(h, `${CONSOLE}/auth/t3/callback`)).toBe('/devices?t3=stale');
    expect(
      await callbackReason(h, h.stub.approve(await start(), { iss: 'https://evil.example' })),
    ).toBe('/devices?t3=issuer');
    expect(await callbackReason(h, h.stub.approve(await start(), { iss: '' }))).toBe(
      '/devices?t3=issuer',
    );
    expect(
      await callbackReason(h, h.stub.approve(await start(), { code: '', error: 'access_denied' })),
    ).toBe('/devices?t3=denied');
    expect(await callbackReason(h, h.stub.approve(await start(), { code: 'forged' }))).toBe(
      '/devices?t3=failed',
    );
    // A used state is stale the second time, even after a refusal consumed it.
    const used = h.stub.approve(await start(), { code: 'forged' });
    expect(await callbackReason(h, used)).toBe('/devices?t3=failed');
    expect(await callbackReason(h, used)).toBe('/devices?t3=stale');
    // Expired after ten minutes.
    const late = h.stub.approve(await start());
    h.clock.now += 10 * 60 * 1000;
    expect(await callbackReason(h, late)).toBe('/devices?t3=stale');
    expect(h.secrets.writes).toBe(0);
  });

  test('a read-only grant is discarded', async () => {
    const h = harness({ stub: { grantedScope: 'orchestration:read' } });
    const started = await h.adapter.connect(CONSOLE);
    if (started.state !== 'authorize') {
      throw new Error('expected an authorization URL');
    }
    expect(await callbackReason(h, h.stub.approve(started.url))).toBe('/devices?t3=read_only');
    expect(h.secrets.writes).toBe(0);
  });

  test('a failed code exchange answers failed', async () => {
    const h = harness({ stub: { tokenStatus: 500 } });
    const started = await h.adapter.connect(CONSOLE);
    if (started.state !== 'authorize') {
      throw new Error('expected an authorization URL');
    }
    expect(await callbackReason(h, h.stub.approve(started.url))).toBe('/devices?t3=failed');
    expect(h.secrets.writes).toBe(0);
  });

  test('a grant whose type is not Bearer answers failed and writes nothing', async () => {
    const h = harness({ stub: { tokenType: 'mac' } });
    expect(await approvedReason(h)).toBe('/devices?t3=failed');
    expect(h.secrets.writes).toBe(0);
  });

  test('expires_in must be a whole number of seconds, at most ten years', async () => {
    const TEN_YEARS = 10 * 365 * 24 * 60 * 60;
    for (const expiresIn of [1.5, '3600', TEN_YEARS + 1]) {
      const h = harness({ stub: { expiresIn } });
      expect(await approvedReason(h)).toBe('/devices?t3=failed');
      expect(h.secrets.writes).toBe(0);
    }
    const longest = harness({ stub: { expiresIn: TEN_YEARS } });
    expect(await approvedReason(longest)).toBe('/devices?t3=connected');
    expect(await longest.adapter.status(CONSOLE)).toMatchObject({ state: 'connected' });
  });

  test('a fault inside the callback still answers its redirect, logging no detail', async () => {
    // A key parseSecretKey never made: sealing it throws.
    const forged = { toJSON: () => 'x', toString: () => 'x' } as unknown as SecretKey;
    const h = harness({ settings: { ...ready, key: forged } });
    expect(await approvedReason(h)).toBe('/devices?t3=failed');
    expect(h.secrets.writes).toBe(0);
    const faults = h.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 't3_connect_fault');
    expect(faults).toHaveLength(1);
    expect(Object.keys(faults[0] ?? {}).toSorted()).toEqual(['event', 'time']);
  });

  test('at most 16 pending authorizations are held; a new one evicts the oldest', async () => {
    const h = harness();
    const urls: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const started = await h.adapter.connect(CONSOLE);
      if (started.state === 'authorize') {
        urls.push(started.url);
      }
    }
    expect(await callbackReason(h, h.stub.approve(urls[0] ?? ''))).toBe('/devices?t3=stale');
    expect(await callbackReason(h, h.stub.approve(urls[1] ?? ''))).toBe('/devices?t3=connected');
  });
});

describe('the saved connection', () => {
  test('no row reads disconnected none, for the status and the catalog alike', async () => {
    const h = harness();
    const none: T3Unavailable = { reason: 'none', state: 'disconnected' };
    expect(await h.adapter.status(CONSOLE)).toEqual(none);
    expect(await h.adapter.catalog('BRF')).toEqual(none);
    expect(h.stub.requests).toEqual([]);
  });

  test('an expired token reads disconnected expired and is not sent', async () => {
    const h = harness();
    await connected(h);
    const sent = h.stub.requests.length;
    h.clock.now += 31 * DAY;
    expect(await h.adapter.status(CONSOLE)).toEqual({ reason: 'expired', state: 'disconnected' });
    expect(await h.adapter.catalog('BRF')).toEqual({ reason: 'expired', state: 'disconnected' });
    expect(h.stub.requests).toHaveLength(sent);
  });

  test('a token reads expired from the instant of its expiry', async () => {
    const h = harness();
    await connected(h);
    h.clock.now += 30 * DAY - 1;
    expect(await h.adapter.status(CONSOLE)).toMatchObject({ state: 'connected' });
    h.clock.now += 1;
    expect(await h.adapter.status(CONSOLE)).toEqual({ reason: 'expired', state: 'disconnected' });
  });

  test('a 401 on one peer read rejects the token for the whole catalog', async () => {
    const h = harness({
      stub: {
        environments: {
          ...world().environments,
          'env-asgard': { label: 'asgard', projects: [], rejecting: true },
        },
      },
    });
    await connected(h);
    expect(await h.adapter.catalog('MMR')).toEqual({ reason: 'rejected', state: 'disconnected' });
  });

  test('a 401 from T3 reads disconnected rejected', async () => {
    const h = harness();
    await connected(h);
    h.stub.revokeToken();
    const rejected: T3Unavailable = { reason: 'rejected', state: 'disconnected' };
    expect(await h.adapter.status(CONSOLE)).toEqual(rejected);
    expect(await h.adapter.catalog('MMR')).toEqual(rejected);
    expect(await h.adapter.catalog('BRF')).toEqual(rejected);
  });

  test('a token sealed for another issuer is never sent and reads rejected', async () => {
    const secrets = memorySecrets();
    await connected(harness({ secrets }));
    const moved = harness({ secrets, settings: { ...ready, url: 'https://t3-new.example' } });
    expect(await moved.adapter.status(CONSOLE)).toEqual({
      reason: 'rejected',
      state: 'disconnected',
    });
    expect(moved.stub.requests).toEqual([]);
  });

  test('a row that fails to open reads as absent and logs an integrity line without its contents', async () => {
    const secrets = memorySecrets();
    const other = parseSecretKey(Buffer.alloc(32, 9).toString('base64'))!;
    const sealed = sealSecret(other, T3_SECRET_NAME, '{"accessToken":"leak-me"}');
    await secrets.write(T3_SECRET_NAME, sealed);
    const h = harness({ secrets });
    expect(await h.adapter.status(CONSOLE)).toEqual({ reason: 'none', state: 'disconnected' });
    expect(h.logs).toEqual([expect.stringContaining('"event":"host_secret_unopenable"')]);
    expect(h.logs.join('\n')).not.toContain(sealed);
    expect(h.stub.requests).toEqual([]);
  });

  test('a T3 that stops answering reads unreachable', async () => {
    const h = harness();
    await connected(h);
    const down = harness({
      fetch: async () => Promise.reject(new TypeError('fetch failed')),
      secrets: h.secrets,
    });
    expect(await down.adapter.status(CONSOLE)).toEqual({ state: 'unreachable' });
    expect(await down.adapter.catalog('MMR')).toEqual({ state: 'unreachable' });
  });
});

describe('the catalog', () => {
  test('lists only systems with a matching project, or that could not be read', async () => {
    const h = harness({ stub: { pageSize: 2 } });
    await connected(h);
    const catalog = await h.adapter.catalog('MMR');
    expect(catalog).toEqual({
      expiresAt: '2026-12-03T12:00:00.000Z',
      noRemote: false,
      state: 'connected',
      systems: [
        {
          configured: true,
          defaultThreadEnvMode: 'worktree',
          environmentId: 'env-valhalla',
          label: 'Valhalla',
          projects: [
            {
              defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-fable-5-1' },
              id: 'p-mimir',
              title: 'mimir',
            },
            { defaultModelSelection: null, id: 'p-mimir-https', title: 'mimir (copy)' },
          ],
          providers: [
            {
              displayName: 'Codex',
              models: [
                {
                  id: 'gpt-6.1-sol',
                  label: null,
                  options: [
                    { default: 'low', id: 'reasoningEffort', values: ['low', 'medium', 'high'] },
                  ],
                },
              ],
              providerInstanceId: 'codex',
              runtimeModes: ['approval-required', 'auto-accept-edits', 'auto'],
            },
            {
              displayName: 'Claude',
              models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1', options: [] }],
              providerInstanceId: 'claudeAgent',
              runtimeModes: ['approval-required'],
            },
          ],
          status: 'reachable',
        },
        { configured: false, environmentId: 'env-mbp', label: 'DB MBP', status: 'unreachable' },
        {
          configured: false,
          defaultThreadEnvMode: 'worktree',
          environmentId: 'env-asgard',
          label: 'asgard',
          projects: [{ defaultModelSelection: null, id: 'p-asgard', title: 'mimir' }],
          providers: [
            {
              displayName: 'Codex',
              models: [
                {
                  id: 'gpt-6.1-sol',
                  label: null,
                  options: [
                    { default: 'low', id: 'reasoningEffort', values: ['low', 'medium', 'high'] },
                  ],
                },
              ],
              providerInstanceId: 'codex',
              runtimeModes: ['approval-required'],
            },
          ],
          status: 'reachable',
        },
        { configured: false, environmentId: 'env-broken', label: 'broken', status: 'unreachable' },
      ],
    });
    // Every page of the configured server's projects was read, cursor by cursor.
    const pages = h.stub.requests
      .filter((request) => request.body.includes('t3_project_list'))
      .map((request) => JSON.parse(request.body).params.arguments)
      .filter((args) => args.environmentId === 'env-valhalla');
    expect(pages).toEqual([
      { environmentId: 'env-valhalla', limit: 100 },
      { cursor: 2, environmentId: 'env-valhalla', limit: 100 },
    ]);
    // Only the fixed tool list was called.
    const tools = new Set(
      h.stub.requests
        .filter((request) => request.body.includes('tools/call'))
        .map((request) => JSON.parse(request.body).params.name),
    );
    expect([...tools].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'orchestrator_capabilities',
      't3_environment_links',
      't3_environment_read',
      't3_project_list',
    ]);
  });

  test('with linked environments off, the configured server is the only system', async () => {
    // T3's unknown-tool answer, or a server with no tools/call method at all.
    for (const stub of [{ links: 'absent' }, { linksError: 'method_not_found' }] as const) {
      const h = harness({ stub });
      await connected(h);
      const catalog = await h.adapter.catalog('MMR');
      expect(
        catalog.state === 'connected' && catalog.systems.map((system) => system.label),
      ).toEqual(['Valhalla']);
    }
  });

  test('a failed links read is a failed read of the configured server, not an absent tool', async () => {
    for (const linksError of ['is_error', 'internal'] as const) {
      const h = harness({ stub: { linksError } });
      await connected(h);
      expect(await h.adapter.catalog('MMR')).toEqual({ state: 'unreachable' });
    }
  });

  test('a system linked twice, or a link naming the configured server, is listed once', async () => {
    const h = harness({
      stub: {
        links: [
          { environmentId: 'env-asgard', label: 'asgard', status: 'reachable' },
          { environmentId: 'env-valhalla', label: 'Valhalla', status: 'reachable' },
          { environmentId: 'env-asgard', label: 'asgard (again)', status: 'reachable' },
          { environmentId: 'env-valhalla', label: 'Valhalla (again)', status: 'unreachable' },
        ],
      },
    });
    await connected(h);
    const catalog = await h.adapter.catalog('MMR');
    expect(
      catalog.state === 'connected' &&
        catalog.systems.map((system) => [system.environmentId, system.label, system.status]),
    ).toEqual([
      ['env-valhalla', 'Valhalla', 'reachable'],
      ['env-asgard', 'asgard', 'reachable'],
    ]);
    expect(
      calledEnvironments(h, 'orchestrator_capabilities').toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['env-asgard', 'env-valhalla']);
  });

  test('a link T3 reports unreachable is listed unreachable without being read', async () => {
    const h = harness({
      stub: {
        environments: {
          ...world().environments,
          'env-mbp': {
            label: 'DB MBP',
            projects: [
              { id: 'p-mbp', remoteUrl: 'https://github.com/dbtlr/mimir', title: 'mimir' },
            ],
          },
        },
      },
    });
    await connected(h);
    const catalog = await h.adapter.catalog('MMR');
    expect(catalog.state === 'connected' && catalog.systems).toContainEqual({
      configured: false,
      environmentId: 'env-mbp',
      label: 'DB MBP',
      status: 'unreachable',
    });
    expect(h.stub.requests.some((request) => request.body.includes('env-mbp'))).toBe(false);
  });

  test('a project list that never ends reads that system unreachable within the page bound', async () => {
    const h = harness({
      stub: {
        environments: {
          ...world().environments,
          'env-asgard': { ...world().environments['env-asgard']!, endlessPages: true },
        },
        pageSize: 1,
      },
    });
    await connected(h);
    const catalog = await h.adapter.catalog('MMR');
    expect(catalog.state === 'connected' && catalog.systems).toContainEqual({
      configured: false,
      environmentId: 'env-asgard',
      label: 'asgard',
      status: 'unreachable',
    });
    expect(
      calledEnvironments(h, 't3_project_list').filter((id) => id === 'env-asgard'),
    ).toHaveLength(100);
  });

  test('a project with no remote answers connected with noRemote, after checking the token', async () => {
    const h = harness();
    await connected(h);
    const sent = h.stub.requests.length;
    expect(await h.adapter.catalog('BRF')).toEqual({
      expiresAt: '2026-12-03T12:00:00.000Z',
      noRemote: true,
      state: 'connected',
      systems: [],
    });
    const calls = h.stub.requests
      .slice(sent)
      .map((request) => JSON.parse(request.body).params?.name);
    expect(calls.filter(Boolean)).toEqual(['t3_environment_read']);
  });

  test('a session id and SSE replies are carried and read', async () => {
    const h = harness({ stub: { links: 'absent', sessionId: 'session-1', sse: true } });
    await connected(h);
    expect(await h.adapter.status(CONSOLE)).toMatchObject({
      label: 'Valhalla',
      state: 'connected',
    });
    const catalog = await h.adapter.catalog('MMR');
    expect(catalog.state === 'connected' && catalog.systems).toHaveLength(1);
  });

  test('a failed tool result on the configured server reads unreachable', async () => {
    const h = harness();
    await connected(h);
    const failing = harness({
      secrets: h.secrets,
      stub: {
        environments: {
          ...world().environments,
          'env-valhalla': { failing: true, label: 'Valhalla', projects: [] },
        },
      },
    });
    expect(await failing.adapter.status(CONSOLE)).toEqual({ state: 'unreachable' });
    expect(await failing.adapter.catalog('MMR')).toEqual({ state: 'unreachable' });
  });

  test('a reply under another JSON-RPC id is refused', async () => {
    const h = harness();
    await connected(h);
    const mismatched = harness({ secrets: h.secrets, stub: { mismatchedReplyId: true } });
    expect(await mismatched.adapter.status(CONSOLE)).toEqual({ state: 'unreachable' });
  });

  test('every request after initialize carries the protocol version T3 chose', async () => {
    const h = harness({ stub: { protocolVersion: '2025-03-26' } });
    await connected(h);
    const sent = h.stub.requests.length;
    await h.adapter.status(CONSOLE);
    const [initialize, ...later] = h.stub.requests.slice(sent);
    expect(initialize?.body).toContain('"method":"initialize"');
    expect(initialize?.headers.get('mcp-protocol-version')).toBeNull();
    expect(later.map((request) => request.headers.get('mcp-protocol-version'))).toEqual([
      '2025-03-26',
      '2025-03-26',
    ]);
  });

  test('no adapter request follows a redirect, and every one has a timeout', async () => {
    const inits: RequestInit[] = [];
    const stub = stubT3(world());
    const h = harness({
      fetch: async (input, init) => {
        inits.push(init);
        return stub.fetch(input, init);
      },
    });
    const started = await h.adapter.connect(CONSOLE);
    expect(started.state).toBe('authorize');
    expect(inits.length).toBeGreaterThan(0);
    expect(
      inits.every((init) => init.redirect === 'manual' && init.signal instanceof AbortSignal),
    ).toBe(true);
  });
});

/** Each adapter log event and the keys its lines may carry. */
const LOG_KEYS: Record<string, string[]> = {
  host_secret_unopenable: ['cause', 'event', 'name', 'time'],
  host_secret_unreadable: ['event', 'name', 'time'],
  host_secret_write_fault: ['event', 'name', 'time'],
  t3_connect_callback: ['event', 'outcome', 'time'],
  t3_connect_fault: ['event', 'time'],
  t3_request_failed: ['endpoint', 'event', 'method', 'status', 'time', 'tool'],
};

test('no secret value or T3 reply body ever appears in the logs', async () => {
  const h = harness();
  const url = await connected(h);
  await h.adapter.status(CONSOLE);
  await h.adapter.catalog('MMR');
  h.stub.revokeToken();
  await h.adapter.status(CONSOLE);
  const failing = harness({ secrets: h.secrets, stub: { tokenStatus: 500 } });
  await approvedReason(failing);
  const unregistered = harness({ stub: { registrationStatus: 400 } });
  await unregistered.adapter.connect(CONSOLE);
  const linksFailing = harness({ stub: { linksError: 'internal' } });
  await connected(linksFailing);
  await linksFailing.adapter.catalog('MMR');
  const linksAbsent = harness({ stub: { links: 'absent' } });
  await connected(linksAbsent);
  await linksAbsent.adapter.catalog('MMR');
  const lines = [h, failing, unregistered, linksFailing, linksAbsent].flatMap((run) => run.logs);
  const logs = lines.join('\n');
  expect(logs).toContain('t3_request_failed');
  const authorize = new URL(url);
  const sealed = h.secrets.rows.get(T3_SECRET_NAME) ?? '';
  const exchange = h.stub.requests.find((request) => request.url.endsWith('/oauth/mcp/token'));
  const exchanged = new URLSearchParams(exchange?.body ?? '');
  for (const secret of [
    exchanged.get('code_verifier') ?? '',
    exchanged.get('code') ?? '',
    STUB_ACCESS_TOKEN,
    KEY_TEXT,
    'stub-code-',
    authorize.searchParams.get('state') ?? '',
    authorize.searchParams.get('code_challenge') ?? '',
    sealed,
    // The stub's failure bodies: T3's words never reach a log line.
    'unauthorized',
    'invalid_grant',
    'invalid_client_metadata',
    'internal error',
    'environment unavailable',
    'not found',
  ]) {
    expect(secret).not.toBe('');
    expect(logs).not.toContain(secret);
  }
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const allowed = LOG_KEYS[String(entry.event)] ?? [];
    expect(
      Object.keys(entry).every((key) => allowed.includes(key)),
      line,
    ).toBe(true);
  }
});
