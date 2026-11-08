import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Engine } from '@mimir/contract';
import type { Run, RunClosingState, RunStore, RunUsage } from '@mimir/core';

import { isEngineRefusal } from '../api/errors';
import { budgetDay, remainingTokens } from './agent-budget';
import { createAgentGate } from './agent-gate';
import { createRunGrant, grantToolNames } from './agent-grant';
import {
  buildRunOptions,
  presentManagedPolicy,
  READER_AGENT,
  runDirectoryFor,
  runPaths,
} from './agent-options';
import { agentState, currentAgent } from './agent-settings';
import type { AgentConnection, AgentSettings, EnabledAgentSettings } from './agent-settings';
import type { AgentMisconfiguration, AgentState } from './agent-states';
import {
  createUsageMeter,
  NO_USAGE,
  PER_TURN_OUTPUT_ALLOWANCE,
  settledUsage,
  SPAWN_ALLOWANCE,
  usageTotal,
} from './agent-usage';
import type { UsageMeter } from './agent-usage';
import type { CloneSyncOptions, CloneSyncResult } from './clones';
import type { GitCredentialsSetting } from './git-credentials';

/*
 * The agent runner (ADR 0041): admits one run at a time against the daily
 * budget, syncs the project's clone, runs the Agent SDK behind the gate and
 * the run grant, keeps the run's row current while it streams, and settles
 * it. Host-internal: no wire, CLI, or MCP surface reaches it.
 */

/** How often the runner's timers fire. */
export type RunnerTiming = {
  /** How often the owning runner marks its row alive. */
  heartbeatMs: number;
  /**
   * A running row whose heartbeat is older than this is interrupted at boot
   * and admission, and shown stale in `status`.
   */
  staleAfterMs: number;
  /** The least time between streamed usage writes. */
  recordEveryMs: number;
};

/**
 * The runner's timing. A heartbeat every 15 seconds against a 2-minute stale
 * window tolerates seven missed beats (a slow database, a long pause), so a
 * live run is never interrupted by another host's admission, while a crashed
 * host frees the one running slot within two minutes. Usage is written at
 * most every 5 seconds: the row stays current for the console, and a run
 * streaming many messages a second does not write on each.
 */
export const RUNNER_TIMING: RunnerTiming = {
  heartbeatMs: 15_000,
  recordEveryMs: 5_000,
  staleAfterMs: 120_000,
};

/** The SDK's `query`, narrowed to what the runner uses, so tests can script a stream. */
export type RunQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close?: () => void };

/** What a run is told: its system prompt and its first message. MMR-633 writes the grooming brief. */
export type RunBrief = { systemPrompt: string; prompt: string };

export type StartRunInput = {
  /** The run's project key. */
  project: string;
  /** The `todo` task the run acts on, in that project. */
  task: string;
  kind: Run['kind'];
  brief: RunBrief;
  trigger: 'console';
};

/** Why a run did not start. */
export type RunRefusal =
  | { reason: 'unconfigured' }
  | ({ reason: 'misconfigured' } & AgentMisconfiguration)
  | { reason: 'disconnected' }
  /** Claude Code managed policy would apply to the run whatever its options say. */
  | { reason: 'managed-policy'; paths: string[] }
  /** No task by that id in the project. */
  | { reason: 'task-not-found' }
  | { reason: 'task-not-todo'; lifecycle: string }
  /** The project has no remote, so the host has no repository to clone. */
  | { reason: 'no-remote' }
  /** The day's usage plus the run's ceiling does not fit the daily budget. */
  | {
      reason: 'budget';
      usedTokens: number;
      runTokens: number;
      dailyTokens: number;
      /** When the budget day resets. */
      resetsAt: Date;
    }
  /**
   * Another run holds the one running slot. `running` is null when that run
   * ended before it could be read, so starting again may be admitted.
   */
  | { reason: 'busy'; running: { id: string; task: string; startedAt: string } | null };

/** How a run ended. `lost` means another host took its row over, so the runner could not close it. */
export type RunOutcome = {
  runId: string;
  state: RunClosingState | 'lost';
  /** The one line recorded on the row. */
  outcome: string;
  usage: RunUsage;
  usageSettled: boolean;
};

/**
 * A started run, which settles in `finished`, or a refusal. A clone that does
 * not sync is no refusal: the run was admitted, so `finished` reports it as a
 * failed run whose outcome names the sync's reason.
 */
export type StartRunResult =
  | { started: true; runId: string; finished: Promise<RunOutcome> }
  | ({ started: false } & RunRefusal);

/** The day's budget as the console shows it. */
export type AgentBudgetStatus = {
  dailyTokens: number;
  runTokens: number;
  usedTokens: number;
  remainingTokens: number;
  /** The next midnight in `timezone`. */
  resetsAt: Date;
  timezone: string;
};

/** The run holding the one running slot, as the console shows it. */
export type RunningRun = {
  run: Run;
  /**
   * Its heartbeat is older than the stale window: its host most likely
   * crashed. The row stays running until the next boot or admission
   * interrupts it; reading status never does.
   */
  stale: boolean;
};

/** What the console reads (MMR-633): the agent state, the day's budget, and the running run. */
export type AgentStatus = {
  agent: AgentState;
  /** Null while agent runs are unconfigured. */
  budget: AgentBudgetStatus | null;
  running: RunningRun | null;
};

export type AgentRunner = {
  startRun: (input: StartRunInput) => Promise<StartRunResult>;
  status: () => Promise<AgentStatus>;
};

export type AgentRunnerOptions = {
  settings: AgentSettings;
  connection: AgentConnection;
  runs: RunStore;
  engine: Engine;
  /** `MIMIR_GIT_CREDENTIALS_FILE` as read at boot; the sync checks it again. */
  gitCredentials: GitCredentialsSetting;
  /** The host process's instance id, which owns the rows it admits. */
  runnerId: string;
  query: RunQuery;
  syncClone: (options: CloneSyncOptions) => Promise<CloneSyncResult>;
  log?: (line: string) => void;
  managedPolicy?: () => Promise<string[]>;
  clock?: () => Date;
  newRunId?: () => string;
  timing?: RunnerTiming;
};

/** Why the runner aborted a run. */
type AbortReason = 'ceiling' | 'lost';

/** The SDK's assistant errors that mean the API refused the token. */
const TOKEN_REJECTIONS = new Set(['authentication_failed', 'oauth_org_not_allowed']);

/** One line: no line breaks, and short enough to read in a list. */
function oneLine(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Remove a per-run directory and everything in it; a failure is logged, never thrown. */
async function removeDirectory(directory: string, log: (line: string) => void): Promise<void> {
  try {
    await rm(directory, { force: true, recursive: true });
  } catch {
    log(`⚠ host: could not remove the agent run directory ${directory}`);
  }
}

/** A start that did not happen, and why. */
function refused(refusal: RunRefusal): StartRunResult {
  return { started: false, ...refusal };
}

/** The refusal for an agent state that is not ready. */
function stateRefusal(state: Exclude<AgentState, { state: 'ready' }>): RunRefusal {
  if (state.state === 'misconfigured') {
    return { problem: state.problem, reason: 'misconfigured', setting: state.setting };
  }
  return { reason: state.state };
}

/** The outcome line for a run that ended with a result and a valid total. */
function describeResult(input: {
  result: SDKResultMessage;
  settled: RunUsage;
  estimate: number;
  ceiling: number;
  spawns: number;
  tokenRejected: boolean;
}): string {
  const { result } = input;
  const total = usageTotal(input.settled);
  const facts = [
    `${result.num_turns} turns`,
    `${input.spawns} reader${input.spawns === 1 ? '' : 's'}`,
    `settled ${total} tokens`,
  ];
  if (total > input.estimate) {
    facts.push(`${total - input.estimate} past its in-flight estimate`);
  }
  if (total > input.ceiling) {
    facts.push(`past its ${input.ceiling}-token ceiling`);
  }
  const summary = facts.join('; ');
  if (input.tokenRejected) {
    return `failed: the API refused the agent token; replace the file MIMIR_AGENT_TOKEN_FILE names (${summary})`;
  }
  if (result.subtype === 'success' && !result.is_error) {
    return `succeeded: ${summary}`;
  }
  const detail =
    result.subtype === 'success' ? `ended on an API error: ${result.result}` : result.subtype;
  return oneLine(`failed: ${detail} (${summary})`);
}

/** The outcome line for a run that ended with no result, or none with a valid total. */
function describeUnsettled(input: {
  aborted: AbortReason | undefined;
  failure: unknown;
  hadResult: boolean;
  tokenRejected: boolean;
  ceiling: number;
  estimate: number;
}): { state: RunClosingState; outcome: string } {
  if (input.aborted === 'ceiling') {
    return {
      outcome: `cancelled: the run reached its ${input.ceiling}-token ceiling (estimated ${input.estimate} tokens) and was stopped`,
      state: 'cancelled',
    };
  }
  if (input.aborted === 'lost') {
    return { outcome: 'failed: the runner lost the run to another host', state: 'failed' };
  }
  if (input.tokenRejected) {
    return {
      outcome:
        'failed: the API refused the agent token; replace the file MIMIR_AGENT_TOKEN_FILE names',
      state: 'failed',
    };
  }
  if (input.hadResult) {
    return { outcome: 'failed: the run ended with no valid usage total', state: 'failed' };
  }
  const message = input.failure instanceof Error ? input.failure.message : 'the stream ended';
  return {
    outcome: oneLine(`failed: the run ended without a result: ${message}`),
    state: 'failed',
  };
}

/** Create the runner. `openHost` builds one per host process. */
export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  const {
    connection,
    engine,
    runs,
    settings,
    log = (line: string) => console.error(line),
    managedPolicy = () => presentManagedPolicy(),
    clock = () => new Date(),
    newRunId = randomUUID,
    timing = RUNNER_TIMING,
  } = options;

  /** The task and its project's remote, or why the run cannot act on it. */
  const checkTask = async (input: StartRunInput): Promise<{ remote: string } | RunRefusal> => {
    let node: Awaited<ReturnType<Engine['getNode']>>;
    try {
      node = await engine.getNode({ facets: ['home'], id: input.task });
    } catch (error) {
      if (isEngineRefusal(error)) {
        return { reason: 'task-not-found' };
      }
      throw error;
    }
    if (node.type !== 'task' || node.home?.projectKey !== input.project) {
      return { reason: 'task-not-found' };
    }
    if (node.lifecycle !== 'todo') {
      return { lifecycle: String(node.lifecycle), reason: 'task-not-todo' };
    }
    const { remote } = await engine.getNode({ id: input.project });
    return remote === null || remote === undefined || remote.trim() === ''
      ? { reason: 'no-remote' }
      : { remote };
  };

  /**
   * Remove every per-run directory but `keep`. Called once a run is admitted:
   * the slot is then this run's, so no other directory belongs to a live run.
   */
  const sweepRunDirectories = async (dataDirectory: string, keep: string) => {
    const parent = dirname(runDirectoryFor(dataDirectory, keep));
    let entries: string[];
    try {
      entries = await readdir(parent);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry !== keep) {
        await removeDirectory(join(parent, entry), log);
      }
    }
  };

  const startRun: AgentRunner['startRun'] = async (input) => {
    const current = await currentAgent(settings, connection);
    if (current.state !== 'ready' || !settings.enabled) {
      return refused(
        current.state === 'ready' ? { reason: 'unconfigured' } : stateRefusal(current),
      );
    }
    const paths = await managedPolicy();
    if (paths.length > 0) {
      return refused({ paths, reason: 'managed-policy' });
    }
    const target = await checkTask(input);
    if ('reason' in target) {
      return refused(target);
    }
    // Admission recovers a stale holder, checks the slot and the day's
    // budget, and inserts the row in one serialized write, so two starts can
    // never both fit a budget only one fits.
    const { budget } = settings;
    const day = budgetDay(clock(), budget.timezone);
    const runId = newRunId();
    const admitted = await runs.admit({
      budget: { dailyTokens: budget.dailyTokens, since: day.startedAt.toISOString() },
      id: runId,
      kind: input.kind,
      model: settings.model,
      project: input.project,
      reservedTokens: budget.runTokens,
      runner: options.runnerId,
      staleAfterMs: timing.staleAfterMs,
      task: input.task,
      trigger: input.trigger,
    });
    if (!admitted.admitted) {
      if (admitted.reason === 'budget') {
        return refused({
          dailyTokens: budget.dailyTokens,
          reason: 'budget',
          resetsAt: day.resetsAt,
          runTokens: budget.runTokens,
          usedTokens: admitted.used,
        });
      }
      const { running } = admitted;
      return refused({
        reason: 'busy',
        running:
          running === null
            ? null
            : { id: running.id, startedAt: running.started_at, task: running.task },
      });
    }
    await sweepRunDirectories(settings.dataDirectory, runId);
    const finished = execute({
      input,
      remote: target.remote,
      runId,
      settings,
      token: current.token,
      tokenIdentity: current.tokenIdentity,
    });
    return { finished, runId, started: true };
  };

  /** One admitted run, from the clone sync to its closed row. Never rejects. */
  const execute = async (run: {
    input: StartRunInput;
    remote: string;
    runId: string;
    settings: EnabledAgentSettings;
    token: string;
    tokenIdentity: string;
  }): Promise<RunOutcome> => {
    const { input, runId } = run;
    const { budget, dataDirectory } = run.settings;
    const runDirectory = runDirectoryFor(dataDirectory, runId);
    const abortController = new AbortController();
    let aborted: AbortReason | undefined;
    const abort = (reason: AbortReason) => {
      aborted ??= reason;
      abortController.abort();
    };
    // An owner-checked write: a lost row aborts the run; a failed write is logged.
    const owned = async (write: Promise<'held' | 'lost'>, what: string) => {
      try {
        if ((await write) === 'lost') {
          abort('lost');
        }
      } catch {
        log(`⚠ host: agent run ${runId}: the ${what} write failed`);
      }
    };
    const close = async (closing: {
      state: RunClosingState;
      outcome: string;
      usage: RunUsage;
      usageSettled: boolean;
      costEstimateUsd: number | null;
    }): Promise<RunOutcome> => {
      const held = await runs.close(runId, options.runnerId, closing);
      return {
        outcome: closing.outcome,
        runId,
        state: held === 'held' ? closing.state : 'lost',
        usage: closing.usage,
        usageSettled: closing.usageSettled,
      };
    };
    // Heartbeats start at admission: a slow clone must not let the row go stale.
    const heartbeat = setInterval(() => {
      void owned(runs.heartbeat(runId, options.runnerId), 'heartbeat');
    }, timing.heartbeatMs);
    const meter = createUsageMeter({
      ceiling: budget.runTokens,
      perTurnOutputAllowance: PER_TURN_OUTPUT_ALLOWANCE,
      spawnAllowance: SPAWN_ALLOWANCE,
    });
    try {
      const sync = await options.syncClone({
        credentials: options.gitCredentials,
        dataDirectory,
        log,
        project: { key: input.project, remote: run.remote },
      });
      if (!sync.ok) {
        // The run never reached the SDK, so it used nothing.
        return await close({
          costEstimateUsd: null,
          outcome: oneLine(`failed: the clone did not sync (${sync.reason}): ${sync.message}`),
          state: 'failed',
          usage: NO_USAGE,
          usageSettled: true,
        });
      }
      const paths = runPaths(runDirectory);
      for (const directory of [paths.configDirectory, paths.home, paths.tmpDirectory]) {
        await mkdir(directory, { mode: 0o700, recursive: true });
      }
      return await stream({
        abort,
        abortController,
        aborted: () => aborted,
        close,
        meter,
        owned,
        run,
        sync,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      log(`⚠ host: agent run ${runId} faulted: ${message}`);
      const closing = {
        costEstimateUsd: null,
        outcome: oneLine(`failed: the runner faulted: ${message}`),
        state: 'failed' as const,
        usage: meter.streamed(),
        usageSettled: false,
      };
      try {
        return await close(closing);
      } catch {
        // The row stays running until stale recovery interrupts it.
        log(`⚠ host: agent run ${runId}: the close write failed`);
        return { ...closing, runId };
      }
    } finally {
      clearInterval(heartbeat);
      // Transcripts are not kept: the run's config, home, and temp go with it.
      await removeDirectory(runDirectory, log);
    }
  };

  /** Run the SDK over the synced clone and settle the run. */
  const stream = async (context: {
    abort: (reason: AbortReason) => void;
    aborted: () => AbortReason | undefined;
    abortController: AbortController;
    close: (closing: {
      state: RunClosingState;
      outcome: string;
      usage: RunUsage;
      usageSettled: boolean;
      costEstimateUsd: number | null;
    }) => Promise<RunOutcome>;
    meter: UsageMeter;
    owned: (write: Promise<'held' | 'lost'>, what: string) => Promise<void>;
    run: {
      input: StartRunInput;
      runId: string;
      settings: EnabledAgentSettings;
      token: string;
      tokenIdentity: string;
    };
    sync: Extract<CloneSyncResult, { ok: true }>;
  }): Promise<RunOutcome> => {
    const { abort, meter, owned, run } = context;
    const { budget, dataDirectory } = run.settings;
    const gate = createAgentGate({
      // Not refunded when the CLI then rejects the spawn (past its concurrency
      // limit, say): the allowance stays charged, which only errs toward stopping early.
      chargeSpawn: () => meter.chargeSpawn(),
      cloneRoot: context.sync.directory,
      dataDirectory,
      grantToolNames,
      readerAgentName: READER_AGENT,
    });
    const grant = createRunGrant({
      // The owner check is the heartbeat write: it matches id, runner, and running.
      checkRow: () => runs.heartbeat(run.runId, options.runnerId),
      engine,
      onLost: () => abort('lost'),
      project: run.input.project,
      task: run.input.task,
    });
    const sdkOptions = buildRunOptions({
      abortController: context.abortController,
      claudePath: run.settings.claudePath,
      cloneRoot: context.sync.directory,
      gate,
      grant,
      maxTurns: budget.maxTurns,
      model: run.settings.model,
      runDirectory: runDirectoryFor(dataDirectory, run.runId),
      systemPrompt: run.input.brief.systemPrompt,
      token: run.token,
    });

    let result: SDKResultMessage | undefined;
    let tokenRejected = false;
    let failure: unknown;
    let recordedAt = Number.NEGATIVE_INFINITY;
    if (context.aborted() === undefined) {
      let query: ReturnType<RunQuery> | undefined;
      try {
        query = options.query({ options: sdkOptions, prompt: run.input.brief.prompt });
        for await (const message of query) {
          meter.observe(message);
          if (
            message.type === 'assistant' &&
            message.error !== undefined &&
            TOKEN_REJECTIONS.has(message.error)
          ) {
            tokenRejected = true;
            connection.reject(run.tokenIdentity);
          }
          if (message.type === 'result') {
            result = message;
          }
          const now = clock().getTime();
          if (result === undefined && now - recordedAt >= timing.recordEveryMs) {
            recordedAt = now;
            // The row holds streamed usage only; the allowances are the in-flight estimate's.
            await owned(runs.recordUsage(run.runId, options.runnerId, meter.streamed()), 'usage');
          }
          if (result === undefined && meter.reachedCeiling()) {
            abort('ceiling');
          }
          if (context.aborted() !== undefined) {
            break;
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        query?.close?.();
      }
    }

    const settled =
      result === undefined ? undefined : settledUsage(result.modelUsage, meter.streamed());
    if (result !== undefined && settled !== undefined) {
      return context.close({
        costEstimateUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
        outcome: describeResult({
          ceiling: budget.runTokens,
          estimate: meter.total(),
          result,
          settled,
          spawns: meter.spawns(),
          tokenRejected,
        }),
        state:
          result.subtype === 'success' && !result.is_error && !tokenRejected
            ? 'succeeded'
            : 'failed',
        usage: settled,
        usageSettled: true,
      });
    }
    // No valid total: the row records the streamed usage and is charged the
    // larger of that and its reservation, which is the run's ceiling.
    const unsettled = describeUnsettled({
      aborted: context.aborted(),
      ceiling: budget.runTokens,
      estimate: meter.total(),
      failure,
      hadResult: result !== undefined,
      tokenRejected,
    });
    return context.close({
      costEstimateUsd: null,
      outcome: unsettled.outcome,
      state: unsettled.state,
      usage: meter.streamed(),
      usageSettled: false,
    });
  };

  const status: AgentRunner['status'] = async () => {
    const agent = await agentState(settings, connection);
    const holder = await runs.running();
    const staleBefore = clock().getTime() - timing.staleAfterMs;
    // Stale as recovery judges it: a heartbeat strictly before the cut-off.
    const running =
      holder === undefined
        ? null
        : { run: holder, stale: new Date(holder.heartbeat_at).getTime() < staleBefore };
    if (!settings.enabled) {
      return { agent, budget: null, running };
    }
    const { budget } = settings;
    const day = budgetDay(clock(), budget.timezone);
    const usedTokens = await runs.tokensUsedSince(day.startedAt.toISOString());
    return {
      agent,
      budget: {
        dailyTokens: budget.dailyTokens,
        remainingTokens: remainingTokens({ dailyTokens: budget.dailyTokens, usedTokens }),
        resetsAt: day.resetsAt,
        runTokens: budget.runTokens,
        timezone: budget.timezone,
        usedTokens,
      },
      running,
    };
  };

  return { startRun, status };
}
