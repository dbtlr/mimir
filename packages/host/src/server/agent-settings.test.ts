import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_DEFAULTS,
  agentStartupWarnings,
  agentState,
  createAgentConnection,
  currentAgent,
  readAgentSettings,
} from './agent-settings';
import type { AgentSettings } from './agent-settings';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

/** A temporary root with a token file and a writable data directory. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mimir-agent-settings-'));
  roots.push(root);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'sk-ant-oat01-secret-token\n');
  const dataDirectory = join(root, 'data');
  await mkdir(dataDirectory);
  return { dataDirectory, root, tokenFile };
}

const hosts = { hosts: ['mimir.example'] };

test('the runtime is unconfigured without the token file setting, and warns about nothing', async () => {
  const { dataDirectory } = await fixture();
  const settings = await readAgentSettings({ MIMIR_AGENT_DAILY_TOKENS: 'x' }, {}, dataDirectory);
  expect(settings).toEqual({ enabled: false });
  expect(agentStartupWarnings(settings)).toEqual([]);
  expect(await agentState(settings, createAgentConnection())).toEqual({ state: 'unconfigured' });
});

test('a configured runtime reads the defaults and is ready with the token file mtime', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  const settings = await readAgentSettings(
    { MIMIR_AGENT_TOKEN_FILE: tokenFile },
    hosts,
    dataDirectory,
  );
  expect(settings).toMatchObject({
    budget: {
      dailyTokens: 10_000_000,
      maxTurns: 50,
      runTokens: 4_000_000,
      timezone: 'UTC',
    },
    enabled: true,
    fallbacks: [],
    model: 'claude-opus-5-5',
    problems: [],
  });
  const current = await currentAgent(settings, createAgentConnection());
  expect(current).toMatchObject({ state: 'ready', token: 'sk-ant-oat01-secret-token' });
  const state = await agentState(settings, createAgentConnection());
  expect(state.state).toBe('ready');
  expect(JSON.stringify(state)).not.toContain('secret-token');
});

test('a missing, empty, or unreadable token file is misconfigured by setting name', async () => {
  const { dataDirectory, root, tokenFile } = await fixture();
  const read = (file: string) =>
    readAgentSettings({ MIMIR_AGENT_TOKEN_FILE: file }, hosts, dataDirectory);
  expect(await read(join(root, 'missing'))).toMatchObject({
    problems: [{ problem: 'unreadable', setting: 'MIMIR_AGENT_TOKEN_FILE' }],
  });
  await writeFile(tokenFile, '  \n');
  const empty = await read(tokenFile);
  expect(empty).toMatchObject({
    problems: [{ problem: 'empty', setting: 'MIMIR_AGENT_TOKEN_FILE' }],
  });
  expect(await agentState(empty, createAgentConnection())).toEqual({
    problem: 'empty',
    setting: 'MIMIR_AGENT_TOKEN_FILE',
    state: 'misconfigured',
  });
  expect(await read(root)).toMatchObject({
    problems: [{ problem: 'unreadable', setting: 'MIMIR_AGENT_TOKEN_FILE' }],
  });
  expect(await read('')).toMatchObject({
    problems: [{ problem: 'unreadable', setting: 'MIMIR_AGENT_TOKEN_FILE' }],
  });
});

test('agents need Host filtering and a writable data directory', async () => {
  const { root, tokenFile } = await fixture();
  const file = join(root, 'a-file');
  await writeFile(file, '');
  const settings = await readAgentSettings(
    { MIMIR_AGENT_TOKEN_FILE: tokenFile },
    {},
    join(file, 'data'),
  );
  expect(settings).toMatchObject({
    problems: [
      { problem: 'unset', setting: 'MIMIR_HOSTS' },
      { problem: 'not writable', setting: 'MIMIR_DATA_DIR' },
    ],
  });
  expect(await agentState(settings, createAgentConnection())).toEqual({
    problem: 'unset',
    setting: 'MIMIR_HOSTS',
    state: 'misconfigured',
  });
  // A data directory that does not exist yet is fine when it can be created.
  const later = await readAgentSettings(
    { MIMIR_AGENT_TOKEN_FILE: tokenFile },
    hosts,
    join(root, 'not-yet', 'data'),
  );
  expect(later).toMatchObject({ problems: [] });
});

test('a read-only data directory is misconfigured', async () => {
  if (process.getuid?.() === 0) {
    return; // root writes anywhere
  }
  const { dataDirectory, tokenFile } = await fixture();
  await chmod(dataDirectory, 0o500);
  try {
    expect(
      await readAgentSettings({ MIMIR_AGENT_TOKEN_FILE: tokenFile }, hosts, dataDirectory),
    ).toMatchObject({ problems: [{ problem: 'not writable', setting: 'MIMIR_DATA_DIR' }] });
  } finally {
    await chmod(dataDirectory, 0o700);
  }
});

test('a Claude Code path that is not an executable file is misconfigured', async () => {
  const { dataDirectory, root, tokenFile } = await fixture();
  const plain = join(root, 'claude');
  await writeFile(plain, '');
  const read = (path: string) =>
    readAgentSettings(
      { MIMIR_AGENT_CLAUDE_PATH: path, MIMIR_AGENT_TOKEN_FILE: tokenFile },
      hosts,
      dataDirectory,
    );
  expect(await read(plain)).toMatchObject({
    problems: [{ problem: 'not executable', setting: 'MIMIR_AGENT_CLAUDE_PATH' }],
  });
  await chmod(plain, 0o755);
  expect(await read(plain)).toMatchObject({ claudePath: plain, problems: [] });
});

test('the token is read again at the point of use, so a fixed or broken file shows at once', async () => {
  const { dataDirectory, root } = await fixture();
  const missing = join(root, 'later');
  const settings = await readAgentSettings(
    { MIMIR_AGENT_TOKEN_FILE: missing },
    hosts,
    dataDirectory,
  );
  const connection = createAgentConnection();
  expect((await agentState(settings, connection)).state).toBe('misconfigured');
  await writeFile(missing, 'rotated-token');
  expect(await currentAgent(settings, connection)).toMatchObject({
    state: 'ready',
    token: 'rotated-token',
  });
  await rm(missing);
  expect((await agentState(settings, connection)).state).toBe('misconfigured');
});

test('a rejected token reads disconnected, with the file’s age, until the file is replaced', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  const settings = await readAgentSettings(
    { MIMIR_AGENT_TOKEN_FILE: tokenFile },
    hosts,
    dataDirectory,
  );
  const connection = createAgentConnection();
  const first = await currentAgent(settings, connection);
  if (first.state !== 'ready') {
    throw new Error('expected a ready runtime');
  }
  connection.reject(first.tokenIdentity);
  // The console says to replace the file, and shows how old the refused one is.
  expect(await agentState(settings, connection)).toEqual({
    reason: 'rejected',
    state: 'disconnected',
    tokenModifiedAt: first.tokenModifiedAt,
  });
  await writeFile(tokenFile, 'a-new-token-of-another-length');
  expect(await currentAgent(settings, connection)).toMatchObject({
    state: 'ready',
    token: 'a-new-token-of-another-length',
  });
});

test('a bad budget or model value warns by setting name and falls back to its default', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  const settings = await readAgentSettings(
    {
      MIMIR_AGENT_BUDGET_TIMEZONE: 'Mars/Olympus_Mons',
      MIMIR_AGENT_DAILY_TOKENS: '-5',
      MIMIR_AGENT_MAX_TURNS: '0',
      MIMIR_AGENT_MODEL: 'claude opus; rm -rf',
      MIMIR_AGENT_RUN_TOKENS: '1e6',
      MIMIR_AGENT_TOKEN_FILE: tokenFile,
    },
    hosts,
    dataDirectory,
  );
  expect(settings).toMatchObject({
    budget: {
      dailyTokens: AGENT_DEFAULTS.dailyTokens,
      maxTurns: AGENT_DEFAULTS.maxTurns,
      runTokens: AGENT_DEFAULTS.runTokens,
      timezone: 'UTC',
    },
    model: AGENT_DEFAULTS.model,
    problems: [],
  });
  const warnings = agentStartupWarnings(settings);
  expect(warnings).toEqual([
    '⚠ host: MIMIR_AGENT_DAILY_TOKENS is invalid; agent runs use 10000000',
    '⚠ host: MIMIR_AGENT_RUN_TOKENS is invalid; agent runs use 4000000',
    '⚠ host: MIMIR_AGENT_MAX_TURNS is invalid; agent runs use 50',
    '⚠ host: MIMIR_AGENT_BUDGET_TIMEZONE is invalid; agent runs use UTC',
    '⚠ host: MIMIR_AGENT_MODEL is invalid; agent runs use claude-opus-5-5',
  ]);
  expect(warnings.join('\n')).not.toContain('rm -rf');
});

test('a budget time zone is stored under the name Intl resolves it to', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  for (const [given, stored] of [
    ['utc', 'UTC'],
    ['america/new_york', 'America/New_York'],
  ]) {
    const settings = await readAgentSettings(
      { MIMIR_AGENT_BUDGET_TIMEZONE: given, MIMIR_AGENT_TOKEN_FILE: tokenFile },
      hosts,
      dataDirectory,
    );
    expect(settings).toMatchObject({ budget: { timezone: stored }, fallbacks: [] });
  }
});

test('a budget time zone given as a UTC offset warns and falls back', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  for (const offset of ['+05:00', '-0300']) {
    const settings = await readAgentSettings(
      { MIMIR_AGENT_BUDGET_TIMEZONE: offset, MIMIR_AGENT_TOKEN_FILE: tokenFile },
      hosts,
      dataDirectory,
    );
    expect(settings).toMatchObject({ budget: { timezone: AGENT_DEFAULTS.timezone } });
    expect(agentStartupWarnings(settings)).toEqual([
      '⚠ host: MIMIR_AGENT_BUDGET_TIMEZONE is invalid; agent runs use UTC',
    ]);
  }
});

test('valid tuning values are used as given', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  expect(
    await readAgentSettings(
      {
        MIMIR_AGENT_BUDGET_TIMEZONE: 'America/New_York',
        MIMIR_AGENT_DAILY_TOKENS: '2000000',
        MIMIR_AGENT_MAX_TURNS: '12',
        MIMIR_AGENT_MODEL: 'claude-sonnet-5-5',
        MIMIR_AGENT_RUN_TOKENS: '500000',
        MIMIR_AGENT_TOKEN_FILE: tokenFile,
      },
      hosts,
      dataDirectory,
    ),
  ).toMatchObject({
    budget: {
      dailyTokens: 2_000_000,
      maxTurns: 12,
      runTokens: 500_000,
      timezone: 'America/New_York',
    },
    fallbacks: [],
    model: 'claude-sonnet-5-5',
  });
});

test('a run ceiling above the daily budget warns and is clamped to it', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  const settings = await readAgentSettings(
    {
      MIMIR_AGENT_DAILY_TOKENS: '1000000',
      MIMIR_AGENT_TOKEN_FILE: tokenFile,
    },
    hosts,
    dataDirectory,
  );
  expect(settings).toMatchObject({ budget: { dailyTokens: 1_000_000, runTokens: 1_000_000 } });
  expect(agentStartupWarnings(settings)).toEqual([
    '⚠ host: MIMIR_AGENT_RUN_TOKENS is above the daily budget; agent runs use 1000000',
  ]);
});

test('startup warnings name each problem and never the token', async () => {
  const { dataDirectory, tokenFile } = await fixture();
  const settings: AgentSettings = await readAgentSettings(
    { MIMIR_AGENT_TOKEN_FILE: tokenFile },
    {},
    dataDirectory,
  );
  expect(agentStartupWarnings(settings)).toEqual([
    '⚠ host: agent runs are not set up: MIMIR_HOSTS is unset; agent runs stay off until it is fixed',
  ]);
  expect(agentStartupWarnings(settings).join('\n')).not.toContain('secret-token');
});
