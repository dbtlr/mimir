import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { createAgentGate } from './agent-gate';
import {
  buildRunOptions,
  MANAGED_POLICY_PATHS,
  presentManagedPolicy,
  READER_AGENT,
  READER_MAX_TURNS,
  runDirectoryFor,
} from './agent-options';
import type { RunOptionsInput } from './agent-options';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

const gate: HookCallback = createAgentGate({
  chargeSpawn: () => true,
  cloneRoot: '/data/clones/ENG',
  dataDirectory: '/data',
  grantToolNames: [],
  readerAgentName: READER_AGENT,
});

function input(overrides: Partial<RunOptionsInput> = {}): RunOptionsInput {
  return {
    abortController: new AbortController(),
    claudePath: '/opt/claude',
    cloneRoot: '/data/clones/ENG',
    gate,
    grant: createSdkMcpServer({ name: 'mimir', tools: [] }),
    maxTurns: 50,
    model: 'claude-opus-5-5',
    runDirectory: runDirectoryFor('/data', 'run-1'),
    systemPrompt: 'Groom ENG-1.',
    token: 'oauth-token',
    ...overrides,
  };
}

test('a run directory sits under the data directory and refuses an id that could climb', () => {
  expect(runDirectoryFor('/data', 'run_1-a')).toBe('/data/agent/runs/run_1-a');
  for (const id of ['', '..', '../x', 'a/b', 'a b', 'x'.repeat(65)]) {
    expect(() => runDirectoryFor('/data', id)).toThrow();
  }
});

test('a run discovers nothing: every option the SDK would otherwise find is pinned', async () => {
  const run = input();
  const options = buildRunOptions(run);
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.tools).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
  expect(options.mcpServers).toEqual({ mimir: run.grant });
  expect(options.cwd).toBe('/data/clones/ENG');
  expect(options.permissionMode).toBe('dontAsk');
  expect(options.model).toBe('claude-opus-5-5');
  expect(options.maxTurns).toBe(50);
  expect(options.systemPrompt).toBe('Groom ENG-1.');
  expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude');
  expect(options.abortController).toBe(run.abortController);
  expect(options.allowedTools).toBeUndefined();
  expect(options.plugins).toBeUndefined();
  expect(options.settings).toBeUndefined();
});

test('without a configured executable the SDK picks its own platform package', () => {
  expect(
    buildRunOptions(input({ claudePath: undefined })).pathToClaudeCodeExecutable,
  ).toBeUndefined();
});

test('canUseTool denies every call it is asked about', async () => {
  const { canUseTool } = buildRunOptions(input());
  if (canUseTool === undefined) {
    throw new Error('canUseTool must be set');
  }
  const signal = new AbortController().signal;
  for (const name of ['Read', 'Bash', 'mcp__mimir__annotate', 'Agent']) {
    const result: PermissionResult | null = await canUseTool(
      name,
      {},
      {
        requestId: 'request',
        signal,
        toolUseID: 'x',
      },
    );
    expect(result).toMatchObject({ behavior: 'deny' });
  }
});

test('the gate is the only hook, sees every tool, and is registered fail-closed', () => {
  const options = buildRunOptions(input());
  expect(Object.keys(options.hooks ?? {})).toEqual(['PreToolUse']);
  const matchers = options.hooks?.PreToolUse ?? [];
  expect(matchers).toHaveLength(1);
  expect(matchers[0]?.onFailure).toBe('block');
  expect(matchers[0]?.matcher).toBeUndefined();
  expect(matchers[0]?.hooks).toEqual([gate]);
});

test('the reader agent has the read tools only and no MCP tools', () => {
  const { agents } = buildRunOptions(input());
  expect(Object.keys(agents ?? {})).toEqual([READER_AGENT]);
  expect(agents?.[READER_AGENT]).toMatchObject({
    background: false,
    disallowedTools: ['mcp__*'],
    maxTurns: READER_MAX_TURNS,
    tools: ['Read', 'Grep', 'Glob'],
  });
  expect(agents?.[READER_AGENT]?.mcpServers).toBeUndefined();
  expect(agents?.[READER_AGENT]?.permissionMode).toBeUndefined();
});

test('the subprocess environment is exactly the run variables, and no host secret reaches it', () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'host-api-key',
    MIMIR_DATABASE_URL: 'postgres://user:secret@db/mimir',
    MIMIR_GIT_CREDENTIALS_FILE: '/run/secrets/git',
    MIMIR_SECRET_KEY: 'host-secret-key',
  });
  try {
    const { env } = buildRunOptions(input());
    expect(env).toEqual({
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_FORK_SUBAGENT: '0',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CONFIG_DIR: '/data/agent/runs/run-1/config',
      HOME: '/data/agent/runs/run-1/home',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/data/agent/runs/run-1/tmp',
    });
    const text = JSON.stringify(env);
    for (const secret of ['host-api-key', 'secret@db', '/run/secrets/git', 'host-secret-key']) {
      expect(text).not.toContain(secret);
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
  }
});

test('the managed policy check names the Linux and macOS paths', () => {
  expect(MANAGED_POLICY_PATHS).toEqual([
    '/etc/claude-code/managed-settings.json',
    '/etc/claude-code/managed-settings.d',
    '/etc/claude-code/managed-mcp.json',
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/Library/Application Support/ClaudeCode/managed-settings.d',
    '/Library/Application Support/ClaudeCode/managed-mcp.json',
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
  ]);
});

test('the managed policy check finds every planted policy path, and none on a clean root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-agent-policy-'));
  roots.push(root);
  expect(await presentManagedPolicy(root)).toEqual([]);
  await mkdir(join(root, 'etc/claude-code/managed-settings.d'), { recursive: true });
  await writeFile(join(root, 'etc/claude-code/managed-mcp.json'), '{}');
  await mkdir(join(root, 'Library/Application Support/ClaudeCode'), { recursive: true });
  await writeFile(join(root, 'Library/Application Support/ClaudeCode/managed-settings.json'), '{}');
  expect(await presentManagedPolicy(root)).toEqual([
    '/etc/claude-code/managed-settings.d',
    '/etc/claude-code/managed-mcp.json',
    '/Library/Application Support/ClaudeCode/managed-settings.json',
  ]);
});

test('a policy directory the host cannot inspect counts as present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-agent-policy-'));
  roots.push(root);
  // A file where a policy directory would be holds no policy.
  await writeFile(join(root, 'etc'), '');
  expect(await presentManagedPolicy(root)).toEqual([]);
  if (process.getuid?.() === 0) {
    return; // root reads any directory
  }
  await mkdir(join(root, 'Library/Application Support/ClaudeCode'), { recursive: true });
  await chmod(join(root, 'Library/Application Support/ClaudeCode'), 0o000);
  try {
    expect(await presentManagedPolicy(root)).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json',
      '/Library/Application Support/ClaudeCode/managed-settings.d',
      '/Library/Application Support/ClaudeCode/managed-mcp.json',
    ]);
  } finally {
    await chmod(join(root, 'Library/Application Support/ClaudeCode'), 0o700);
  }
});
