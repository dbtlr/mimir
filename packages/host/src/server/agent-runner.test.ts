import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  HookCallback,
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  chargedTokens,
  createInitiative,
  createPhase,
  createProject,
  createRunStore,
  createTask,
  LocalEngine,
  queueTask,
  sqliteDialect,
} from '@mimir/core';
import type { RunStore } from '@mimir/core';
import { createSqliteTestStore } from '@mimir/core/testing';
import type { SqliteTestStore } from '@mimir/core/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createAgentRunner } from './agent-runner';
import type { AgentRunner, AgentRunnerOptions, RunQuery } from './agent-runner';
import { agentState, createAgentConnection, readAgentToken } from './agent-settings';
import type { AgentConnection, EnabledAgentSettings } from './agent-settings';
import { PER_TURN_OUTPUT_ALLOWANCE, SPAWN_ALLOWANCE } from './agent-usage';
import type { CloneSyncOptions, CloneSyncResult } from './clones';

/*
 * One run's lifecycle (ADR 0041), from admission to settlement, against a
 * real runs table, the real gate and grant, and a scripted SDK stream in
 * place of Claude Code.
 */

const BRIEF = { prompt: 'Groom the task.', systemPrompt: 'You groom tasks.' };
const MODEL = 'claude-opus-5-5';

/** What a script can see and do while its run streams. */
type ScriptContext = {
  options: Options;
  prompt: string;
  /** Resolves when the runner aborts the run. */
  aborted: Promise<void>;
  /** Ask the gate about one tool call from the main agent. */
  gate: (tool: string, input: Record<string, unknown>) => Promise<'allow' | 'deny'>;
  /** Call one grant tool through a real MCP client; whether it was refused. */
  grant: (tool: string, args: Record<string, unknown>) => Promise<{ refused: boolean }>;
};
type Script = (context: ScriptContext) => AsyncGenerator<SDKMessage>;

/** A stand-in for the SDK's query: it runs `script` and ends with an error once aborted, as the SDK does. */
function scriptedQuery(script: Script) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: RunQuery = ({ options, prompt }) => {
    calls.push({ options, prompt });
    const signal = options.abortController?.signal;
    if (signal === undefined) {
      throw new Error('the runner must pass an abort controller');
    }
    const { promise: aborted, resolve: onAbort } = Promise.withResolvers<void>();
    signal.addEventListener('abort', () => onAbort(), { once: true });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const context: ScriptContext = {
      aborted,
      gate: async (tool, input) => {
        const answer = await hook(
          {
            cwd: options.cwd ?? '',
            hook_event_name: 'PreToolUse',
            permission_mode: 'dontAsk',
            session_id: 's',
            tool_input: input,
            tool_name: tool,
            tool_use_id: 't',
            transcript_path: '',
          },
          't',
          { signal: new AbortController().signal },
        );
        const output = answer as { hookSpecificOutput: { permissionDecision: 'allow' | 'deny' } };
        return output.hookSpecificOutput.permissionDecision;
      },
      grant: async (tool, args) => {
        const server = Object.values(options.mcpServers ?? {})[0] as McpSdkServerConfigWithInstance;
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverSide);
        const client = new Client({ name: 'runner-test', version: '1.0.0' });
        await client.connect(clientSide);
        const answer = await client.callTool({ arguments: args, name: tool });
        await client.close();
        return { refused: answer.isError === true };
      },
      options,
      prompt,
    };
    return (async function* stream() {
      for await (const message of script(context)) {
        if (signal.aborted) {
          throw new Error('Claude Code process aborted by user');
        }
        yield message;
      }
      if (signal.aborted) {
        throw new Error('Claude Code process aborted by user');
      }
    })();
  };
  return { calls, query };
}

type Usage = { input: number; output?: number; read?: number; write?: number };

/** A main-loop assistant message; `agent` makes it a subagent's. */
function assistant(id: string, used: Usage, extra: Record<string, unknown> = {}): SDKMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    message: {
      content: [],
      id,
      model: MODEL,
      role: 'assistant',
      usage: {
        cache_creation_input_tokens: used.write ?? 0,
        cache_read_input_tokens: used.read ?? 0,
        input_tokens: used.input,
        output_tokens: used.output ?? 1,
      },
    },
    parent_tool_use_id: null,
    session_id: 's',
    type: 'assistant',
    uuid: crypto.randomUUID(),
    ...extra,
  } as unknown as SDKMessage;
}

const modelUsage = (input: number, output: number, read = 0, write = 0) => ({
  cacheCreationInputTokens: write,
  cacheReadInputTokens: read,
  contextWindow: 200_000,
  costUSD: 0.25,
  inputTokens: input,
  maxOutputTokens: 32_000,
  outputTokens: output,
  webSearchRequests: 0,
});

/** A result message. */
function result(fields: Record<string, unknown> = {}): SDKMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    duration_api_ms: 1,
    duration_ms: 1,
    is_error: false,
    modelUsage: { [MODEL]: modelUsage(100, 2_000, 50_000, 4_000) },
    num_turns: 3,
    permission_denials: [],
    result: 'Groomed.',
    session_id: 's',
    stop_reason: 'end_turn',
    subtype: 'success',
    total_cost_usd: 1.5,
    type: 'result',
    usage: {},
    uuid: crypto.randomUUID(),
    ...fields,
  } as unknown as SDKMessage;
}

let root: string;
let dataDirectory: string;
let tokenFile: string;
let fixture: SqliteTestStore;
let engine: LocalEngine;
let runs: RunStore;
let time: Date;
let task: string;
let phase: string;
let connection: AgentConnection;
let syncs: CloneSyncOptions[];
let syncResult: () => Promise<CloneSyncResult>;

const settings = (
  overrides: Partial<EnabledAgentSettings['budget']> = {},
): EnabledAgentSettings => ({
  budget: {
    dailyTokens: 10_000_000,
    maxTurns: 50,
    runTokens: 4_000_000,
    timezone: 'UTC',
    ...overrides,
  },
  claudePath: undefined,
  dataDirectory,
  enabled: true,
  fallbacks: [],
  hostFiltering: true,
  model: MODEL,
  problems: [],
  tokenFile,
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mimir-agent-runner-')));
  dataDirectory = join(root, 'data');
  await mkdir(dataDirectory);
  tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'sk-ant-oat01-test\n');
  fixture = await createSqliteTestStore();
  engine = new LocalEngine(fixture.store);
  time = new Date('2026-11-08T12:00:00.000Z');
  runs = createRunStore({
    clock: () => time.toISOString(),
    db: fixture.db,
    dialect: sqliteDialect,
  });
  await createProject(fixture.store, {
    key: 'ENG',
    name: 'Engine',
    remote: 'https://github.com/acme/eng',
  });
  await createProject(fixture.store, { key: 'LOC', name: 'Local' });
  const initiative = await createInitiative(fixture.store, { projectId: 'ENG', title: 'Agents' });
  phase = (await createPhase(fixture.store, { parentId: initiative.id, title: 'Runner' })).id;
  task = (await createTask(fixture.store, { parentId: phase, title: 'Groom me' })).id;
  connection = createAgentConnection();
  syncs = [];
  syncResult = async () => {
    const directory = join(dataDirectory, 'clones', 'ENG');
    await mkdir(directory, { recursive: true });
    return { branch: 'main', commit: 'abc123', directory, fresh: true, ok: true };
  };
});

afterEach(async () => {
  await fixture.close();
  await rm(root, { force: true, recursive: true });
});

/** A runner over the fixture with a scripted SDK. */
function runner(script: Script, overrides: Partial<AgentRunnerOptions> = {}) {
  const scripted = scriptedQuery(script);
  const lines: string[] = [];
  const created: AgentRunner = createAgentRunner({
    clock: () => time,
    connection,
    engine,
    gitCredentials: { configured: false },
    log: (line) => lines.push(line),
    managedPolicy: async () => [],
    query: scripted.query,
    runnerId: 'host-a',
    runs,
    settings: settings(),
    syncClone: async (options) => {
      syncs.push(options);
      return syncResult();
    },
    timing: { heartbeatMs: 60_000, recordEveryMs: 0, staleAfterMs: 120_000 },
    ...overrides,
  });
  return { calls: scripted.calls, lines, runner: created };
}

/** Start a run of the fixture task that must be admitted. */
async function started(created: AgentRunner, input: { task?: string; project?: string } = {}) {
  const start = await created.startRun({
    brief: BRIEF,
    kind: 'groom',
    project: input.project ?? 'ENG',
    task: input.task ?? task,
    trigger: 'console',
  });
  if (!start.started) {
    throw new Error(`refused: ${start.reason}`);
  }
  return start;
}

/** The per-run directories left under MIMIR_DATA_DIR. */
async function runDirectories(): Promise<string[]> {
  try {
    return await readdir(join(dataDirectory, 'agent', 'runs'));
  } catch {
    return [];
  }
}

/** Whether anything is at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('admission to settlement', () => {
  test('a run streams, settles from modelUsage over every model, and removes its directory', async () => {
    let seen: { runDirectory: boolean; row: unknown } | undefined;
    const { calls, runner: created } = runner(async function* script({ options }) {
      yield { session_id: 's', subtype: 'init', type: 'system' } as unknown as SDKMessage;
      yield assistant('msg_1', { input: 10, read: 1_000, write: 200 });
      yield assistant('msg_1', { input: 10, read: 1_000, write: 200 });
      yield assistant('msg_2', { input: 5, output: 3, read: 1_500 });
      // A subagent's message: its spawn allowance covers it, not its streamed usage.
      yield assistant(
        'msg_sub',
        { input: 90_000 },
        { agent_id: 'a1', parent_tool_use_id: 'toolu_1' },
      );
      seen = {
        row: await runs.running(),
        runDirectory: await exists(String(options.env?.CLAUDE_CONFIG_DIR)),
      };
      // The CLI's own background model, which the run never named, is in modelUsage too.
      yield result({
        modelUsage: {
          'claude-haiku-5-5': modelUsage(1_400, 100),
          'claude-opus-5-5': modelUsage(100, 2_000, 50_000, 4_000),
        },
      });
    });
    const started_ = await started(created);
    const outcome = await started_.finished;

    expect(outcome).toMatchObject({
      runId: started_.runId,
      state: 'succeeded',
      usage: {
        cacheReadTokens: 50_000,
        cacheWriteTokens: 4_000,
        inputTokens: 1_500,
        outputTokens: 2_100,
      },
      usageSettled: true,
    });
    expect(outcome.outcome).not.toContain('\n');
    // In flight, the row held the main loop's streamed usage, once per id, plus a per-turn allowance each.
    expect(seen).toEqual({
      row: expect.objectContaining({
        cache_read_tokens: 2_500,
        cache_write_tokens: 200,
        input_tokens: 15,
        output_tokens: 4 + 2 * PER_TURN_OUTPUT_ALLOWANCE,
        reserved_tokens: 4_000_000,
        state: 'running',
      }),
      runDirectory: true,
    });
    const row = await runs.get(started_.runId);
    expect(row).toMatchObject({
      cost_estimate_usd: 1.5,
      input_tokens: 1_500,
      model: MODEL,
      output_tokens: 2_100,
      project: 'ENG',
      state: 'succeeded',
      task,
      trigger: 'console',
      usage_settled: true,
    });
    expect(row === undefined ? 0 : chargedTokens(row)).toBe(57_600);
    expect(await runDirectories()).toEqual([]);

    // The SDK got the brief, the clone's real path as its cwd, and the run's settings.
    const [call] = calls;
    expect(call?.prompt).toBe(BRIEF.prompt);
    expect(call?.options).toMatchObject({
      cwd: join(dataDirectory, 'clones', 'ENG'),
      maxTurns: 50,
      model: MODEL,
      systemPrompt: BRIEF.systemPrompt,
    });
    expect(String(call?.options.env?.CLAUDE_CONFIG_DIR)).toStartWith(
      join(dataDirectory, 'agent', 'runs', started_.runId),
    );
    expect(call?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
    // The sync ran after admission, for the run's project and remote.
    expect(syncs).toEqual([
      expect.objectContaining({
        credentials: { configured: false },
        dataDirectory,
        project: { key: 'ENG', remote: 'github.com/acme/eng' },
      }),
    ]);
  });

  test('a result whose subtype is an error closes failed with its settled usage', async () => {
    const { runner: created } = runner(async function* script() {
      yield assistant('msg_1', { input: 10 });
      yield result({ is_error: true, num_turns: 50, subtype: 'error_max_turns' });
    });
    const outcome = await (await started(created)).finished;
    expect(outcome.state).toBe('failed');
    expect(outcome.usageSettled).toBe(true);
    expect(outcome.outcome).toContain('error_max_turns');
    expect(await runDirectories()).toEqual([]);
  });

  test('a settled total past the in-flight estimate is recorded in the outcome', async () => {
    const { runner: created } = runner(async function* script() {
      yield assistant('msg_1', { input: 10 });
      yield result({ modelUsage: { [MODEL]: modelUsage(500_000, 1_000) } });
    });
    const outcome = await (await started(created)).finished;
    expect(outcome.state).toBe('succeeded');
    expect(outcome.outcome).toMatch(/past (the|its) in-flight estimate/);
  });
});

/** Start a run that must be refused, and answer the refusal. */
async function refusal(created: AgentRunner, input: { task?: string; project?: string } = {}) {
  const start = await created.startRun({
    brief: BRIEF,
    kind: 'groom',
    project: input.project ?? 'ENG',
    task: input.task ?? task,
    trigger: 'console',
  });
  expect(start.started).toBe(false);
  return start;
}
/** A script for runs that must never start. */
const never: Script = async function* never() {
  yield result();
};

describe('refusals', () => {
  test('each agent state but ready refuses before anything is written', async () => {
    const unconfigured = runner(never, { settings: { enabled: false } });
    expect(await refusal(unconfigured.runner)).toEqual({ reason: 'unconfigured', started: false });

    const token = await readAgentToken(tokenFile);
    if (!('identity' in token)) {
      throw new Error('the fixture token must read');
    }
    connection.reject(token.identity);
    expect(await refusal(runner(never).runner)).toEqual({ reason: 'disconnected', started: false });

    await rm(tokenFile);
    expect(await refusal(runner(never).runner)).toEqual({
      problem: 'unreadable',
      reason: 'misconfigured',
      setting: 'MIMIR_AGENT_TOKEN_FILE',
      started: false,
    });
    expect(await runs.running()).toBeUndefined();
    expect(syncs).toEqual([]);
  });

  test('a managed policy path refuses the run', async () => {
    const { calls, runner: created } = runner(never, {
      managedPolicy: async () => ['/etc/claude-code/managed-settings.json'],
    });
    expect(await refusal(created)).toEqual({
      paths: ['/etc/claude-code/managed-settings.json'],
      reason: 'managed-policy',
      started: false,
    });
    expect(calls).toEqual([]);
  });

  test('a task that does not exist, is in another project, or is not todo is refused', async () => {
    const { runner: created } = runner(never);
    expect(await refusal(created, { task: 'ENG-999' })).toMatchObject({ reason: 'task-not-found' });
    expect(await refusal(created, { project: 'LOC' })).toMatchObject({ reason: 'task-not-found' });
    expect(await refusal(created, { task: phase })).toMatchObject({ reason: 'task-not-found' });
    await queueTask(fixture.store, task, { harness: 'claude', session: 'operator' });
    expect(await refusal(created)).toMatchObject({ lifecycle: 'queued', reason: 'task-not-todo' });
    expect(await runs.running()).toBeUndefined();
  });

  test('a project without a remote is refused', async () => {
    const initiative = await createInitiative(fixture.store, { projectId: 'LOC', title: 'Local' });
    const localPhase = await createPhase(fixture.store, { parentId: initiative.id, title: 'P' });
    const local = await createTask(fixture.store, { parentId: localPhase.id, title: 'Local task' });
    expect(await refusal(runner(never).runner, { project: 'LOC', task: local.id })).toEqual({
      reason: 'no-remote',
      started: false,
    });
  });

  test('a second start while one runs is busy, and names the running run', async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { runner: created } = runner(async function* script() {
      await held;
      yield result();
    });
    const first = await started(created);
    const other = (await createTask(fixture.store, { parentId: phase, title: 'Another' })).id;
    expect(await refusal(created, { task: other })).toMatchObject({
      reason: 'busy',
      running: { id: first.runId, task },
    });
    release();
    expect((await first.finished).state).toBe('succeeded');
  });

  test('the budget refuses a run that does not fit, naming when the day resets in its zone', async () => {
    // 03:00 UTC on the 8th is 22:00 on the 7th in New York; that day began at 05:00 UTC on the 7th.
    const spent = async (id: string, startedAt: string, tokens: number) => {
      time = new Date(startedAt);
      await runs.admit({
        id,
        kind: 'groom',
        model: MODEL,
        project: 'ENG',
        reservedTokens: 0,
        runner: 'host-old',
        staleAfterMs: 120_000,
        task,
        trigger: 'console',
      });
      await runs.close(id, 'host-old', {
        costEstimateUsd: null,
        outcome: 'done',
        state: 'succeeded',
        usage: { cacheReadTokens: tokens, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
        usageSettled: true,
      });
    };
    // Before the New York day began: not counted.
    await spent('before', '2026-11-07T04:30:00.000Z', 9_000_000);
    await spent('within', '2026-11-07T06:00:00.000Z', 6_500_000);
    time = new Date('2026-11-08T03:00:00.000Z');
    const zoned = runner(
      async function* zoned() {
        yield result();
      },
      { settings: settings({ timezone: 'America/New_York' }) },
    );
    expect(await refusal(zoned.runner)).toEqual({
      dailyTokens: 10_000_000,
      reason: 'budget',
      resetsAt: new Date('2026-11-08T05:00:00.000Z'),
      runTokens: 4_000_000,
      started: false,
      usedTokens: 6_500_000,
    });
    expect(zoned.calls).toEqual([]);

    // In UTC the 8th began at midnight, after both runs, so the same run fits.
    const utc = runner(async function* utc() {
      yield result();
    });
    expect((await (await started(utc.runner)).finished).state).toBe('succeeded');
  });
});

describe('in flight', () => {
  test('a failed sync closes the run failed with zero settled usage and starts no SDK run', async () => {
    syncResult = async () => ({
      message: 'git could not fetch github.com/acme/eng',
      ok: false,
      reason: 'fetch',
    });
    const { calls, runner: created } = runner(async function* script() {
      yield result();
    });
    const start = await started(created);
    const outcome = await start.finished;
    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({
      state: 'failed',
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
      usageSettled: true,
    });
    expect(outcome.outcome).toContain('fetch');
    const row = await runs.get(start.runId);
    expect(row).toMatchObject({ state: 'failed', usage_settled: true });
    expect(row === undefined ? -1 : chargedTokens(row)).toBe(0);
    expect(await runDirectories()).toEqual([]);
  });

  test('the gate charges a spawn allowance against the ceiling and denies one that does not fit', async () => {
    const decisions: string[] = [];
    const { runner: created } = runner(
      async function* script({ gate }) {
        const spawn = { description: 'survey', prompt: 'read src', subagent_type: 'reader' };
        decisions.push(await gate('Agent', spawn));
        decisions.push(await gate('Agent', { ...spawn, run_in_background: true }));
        decisions.push(await gate('Agent', spawn));
        decisions.push(await gate('Agent', spawn));
        yield result();
      },
      { settings: settings({ runTokens: 2 * SPAWN_ALLOWANCE + 100_000 }) },
    );
    await (
      await started(created)
    ).finished;
    expect(decisions).toEqual(['allow', 'deny', 'allow', 'deny']);
  });

  test('the run aborts at its ceiling, closes cancelled, and counts its reservation or streamed usage', async () => {
    const ceiling = 100_000;
    const { runner: created } = runner(
      async function* script({ aborted }) {
        for (let index = 0; index < 100; index += 1) {
          yield assistant(`msg_${index}`, { input: 30_000 });
        }
        await aborted;
        yield result();
      },
      { settings: settings({ runTokens: ceiling }) },
    );
    const start = await started(created);
    const outcome = await start.finished;
    // Turns of 30k plus an 8k allowance each: the third reaches the ceiling, and no fourth is counted.
    expect(outcome.state).toBe('cancelled');
    expect(outcome.usageSettled).toBe(false);
    expect(outcome.outcome).toContain('ceiling');
    const row = await runs.get(start.runId);
    expect(row).toMatchObject({ input_tokens: 90_000, state: 'cancelled', usage_settled: false });
    expect(row === undefined ? 0 : chargedTokens(row)).toBe(
      90_000 + 3 + 3 * PER_TURN_OUTPUT_ALLOWANCE,
    );
    expect(await runDirectories()).toEqual([]);
  });

  test('a run that ends without a result counts the larger of its reservation and streamed usage', async () => {
    const { runner: created } = runner(async function* script() {
      yield assistant('msg_1', { input: 10 });
      throw new Error('Claude Code process exited with code 1');
    });
    const start = await started(created);
    const outcome = await start.finished;
    expect(outcome).toMatchObject({ state: 'failed', usageSettled: false });
    expect(outcome.outcome).toContain('without a result');
    const row = await runs.get(start.runId);
    expect(row === undefined ? 0 : chargedTokens(row)).toBe(4_000_000);
    expect(await runDirectories()).toEqual([]);
  });

  test('an SDK that cannot start closes the run failed and still removes its directory', async () => {
    const { runner: created } = runner(async function* script() {}, {
      query: () => {
        throw new Error('Claude Code executable not found');
      },
    });
    const start = await started(created);
    const outcome = await start.finished;
    expect(outcome).toMatchObject({ state: 'failed', usageSettled: false });
    expect(outcome.outcome).toContain('executable not found');
    expect(await runDirectories()).toEqual([]);
  });

  test('a result with no valid total closes unsettled', async () => {
    const { runner: created } = runner(async function* script() {
      yield assistant('msg_1', { input: 10_000 });
      // A crashed run's result may carry zeroed counts.
      yield result({ is_error: true, modelUsage: {}, subtype: 'error_during_execution' });
    });
    const start = await started(created);
    const outcome = await start.finished;
    expect(outcome).toMatchObject({ state: 'failed', usageSettled: false });
    const row = await runs.get(start.runId);
    expect(row === undefined ? 0 : chargedTokens(row)).toBe(4_000_000);
  });

  test('a heartbeat that finds the row lost aborts the run', async () => {
    const { runner: created } = runner(
      async function* script({ aborted }) {
        // Another host's recovery takes the row over.
        await fixture.db.updateTable('runs').set({ state: 'interrupted' }).execute();
        await aborted;
        yield result();
      },
      { timing: { heartbeatMs: 5, recordEveryMs: 0, staleAfterMs: 120_000 } },
    );
    const start = await started(created);
    const outcome = await start.finished;
    expect(outcome.state).toBe('lost');
    expect((await runs.get(start.runId))?.state).toBe('interrupted');
    expect(await runDirectories()).toEqual([]);
  });

  test('a grant write that finds the row lost is refused and aborts the run', async () => {
    let refused: boolean | undefined;
    const { runner: created } = runner(async function* script({ aborted, grant }) {
      await fixture.db.updateTable('runs').set({ runner: 'host-b' }).execute();
      refused = (await grant('annotate', { content: 'a note' })).refused;
      await aborted;
      yield result();
    });
    const outcome = await (await started(created)).finished;
    expect(refused).toBe(true);
    expect(outcome.state).toBe('lost');
    expect(await engine.getNode({ facets: ['annotations'], id: task })).toMatchObject({
      annotations: [],
    });
  });

  test('a usage write that finds the row lost aborts the run', async () => {
    const { runner: created } = runner(async function* script({ aborted }) {
      await fixture.db.updateTable('runs').set({ runner: 'host-b' }).execute();
      yield assistant('msg_1', { input: 10 });
      await aborted;
      yield result();
    });
    expect((await (await started(created)).finished).state).toBe('lost');
  });

  test('an authentication rejection records the token disconnected', async () => {
    const { runner: created } = runner(async function* script() {
      yield assistant('msg_1', { input: 0, output: 0 }, { error: 'authentication_failed' });
      yield result({
        is_error: true,
        modelUsage: {},
        result: 'Invalid bearer token',
      });
    });
    const outcome = await (await started(created)).finished;
    expect(outcome.state).toBe('failed');
    expect(outcome.outcome).toContain('MIMIR_AGENT_TOKEN_FILE');
    expect(await agentState(settings(), connection)).toEqual({
      reason: 'rejected',
      state: 'disconnected',
    });
  });

  test('admission sweeps run directories left by runs that are no longer running', async () => {
    const orphan = join(dataDirectory, 'agent', 'runs', 'old-run');
    await mkdir(join(orphan, 'config'), { recursive: true });
    await writeFile(join(orphan, 'config', 'transcript.jsonl'), 'old transcript');
    let during: string[] = [];
    const { runner: created } = runner(async function* script() {
      during = await runDirectories();
      yield result();
    });
    const start = await started(created);
    await start.finished;
    expect(during).toEqual([start.runId]);
    expect(await runDirectories()).toEqual([]);
  });
});

describe('status', () => {
  test('reads the agent state, the day so far, the next reset, and the running run', async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { runner: created } = runner(async function* script() {
      await held;
      yield result();
    });
    const idle = await created.status();
    expect(idle).toEqual({
      agent: { state: 'ready', tokenModifiedAt: expect.any(Date) },
      budget: {
        dailyTokens: 10_000_000,
        remainingTokens: 10_000_000,
        resetsAt: new Date('2026-11-09T00:00:00.000Z'),
        runTokens: 4_000_000,
        timezone: 'UTC',
        usedTokens: 0,
      },
      running: null,
    });
    const start = await started(created);
    const busy = await created.status();
    expect(busy.budget).toMatchObject({ remainingTokens: 6_000_000, usedTokens: 4_000_000 });
    expect(busy.running).toMatchObject({ id: start.runId, state: 'running', task });
    release();
    await start.finished;
  });

  test('reads no budget while agents are unconfigured', async () => {
    const { runner: created } = runner(async function* script() {}, {
      settings: { enabled: false },
    });
    expect(await created.status()).toEqual({
      agent: { state: 'unconfigured' },
      budget: null,
      running: null,
    });
  });
});
