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
import { usableRemote } from './clones';
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
  /** How long a cancelled run's query may run on before the runner aborts it. */
  cancelGraceMs: number;
};

/**
 * How long a run cancelled after its query exists may take to end with a
 * result before the runner aborts it (ADR 0041's 2026-11-09 refinement): a
 * main turn and a reader's turn back to back near the per-turn output
 * allowance at typical output speed.
 */
export const CANCEL_GRACE_MS = 300_000;

/**
 * The runner's timing. A heartbeat every 15 seconds against a 2-minute stale
 * window tolerates seven missed beats (a slow database, a long pause), so a
 * live run is never interrupted by another host's admission, while a crashed
 * host frees the one running slot within two minutes. Usage is written at
 * most every 5 seconds: the row stays current for the console, and a run
 * streaming many messages a second does not write on each.
 */
export const RUNNER_TIMING: RunnerTiming = {
  cancelGraceMs: CANCEL_GRACE_MS,
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
      /** The budget day's IANA time zone, whose midnight `resetsAt` is. */
      timezone: string;
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
  /** This process holds the run in its registry, so a cancel here can reach it. */
  held: boolean;
  /** This process holds the run and its stream has ended: a cancel would change nothing. */
  ending: boolean;
  /** A cancel is recorded on the run, which this process holds. */
  stopping: boolean;
};

/**
 * What a cancel answers (ADR 0041's 2026-11-09 refinement), the first that
 * holds. Only `cancelling` records a cancel.
 */
export type CancelRunResult =
  /** This process holds the run and its stream has not ended; the cancel is recorded. */
  | { answer: 'cancelling' }
  /** This process holds the run and its stream has ended; the run closes as it would have. */
  | { answer: 'ending' }
  /** No row has that id. */
  | { answer: 'unknown' }
  /** The row is no longer running; `state` is the state it ended in. */
  | { answer: 'ended'; state: Exclude<Run['state'], 'running'> }
  /** The row runs under this process's runner id, which no longer holds it: its close write failed. */
  | { answer: 'closing' }
  /** The row's heartbeat is older than the stale window. */
  | { answer: 'stale' }
  /** The row's runner is another process, which nothing here reaches. */
  | { answer: 'another-host' };

/** What the console reads (MMR-633): the agent state, the day's budget, the model, and the running run. */
export type AgentStatus = {
  agent: AgentState;
  /** Null while agent runs are unconfigured. */
  budget: AgentBudgetStatus | null;
  /** The model a new run uses; null while agent runs are unconfigured. */
  model: string | null;
  /**
   * The Claude Code managed settings paths present on the host, which a start
   * refuses on; empty when there are none or agent runs are unconfigured.
   */
  managedPolicy: string[];
  running: RunningRun | null;
};

export type AgentRunner = {
  startRun: (input: StartRunInput) => Promise<StartRunResult>;
  status: () => Promise<AgentStatus>;
  /** Cancel a run by its id: recorded only when this process holds it and its stream runs. */
  cancelRun: (runId: string) => Promise<CancelRunResult>;
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

/** Why the runner aborted a run. `cancel-grace`: a cancelled run's grace period ran out. */
type AbortReason = 'ceiling' | 'lost' | 'cancel-grace';

/**
 * One run this process holds, from its admission until its last close attempt
 * settles (the registry of ADR 0041's 2026-11-09 refinement).
 */
type HeldRun = {
  /** A cancel is recorded. */
  cancelled: boolean;
  /**
   * Its stream has ended: its result arrived, it stopped without one, or the
   * runner has settled on how it closes. A cancel no longer changes anything.
   */
  ended: boolean;
  /** Called when a cancel is recorded once the query exists: starts the grace timer. */
  onCancel: (() => void) | undefined;
  /** The SDK query has been created, so the run may have used tokens. */
  queryStarted: boolean;
};

/**
 * What the outcome line of a run the operator cancelled from the console
 * starts with. The runner writes it; the console reads it to tell that run
 * from one a ceiling stopped, whose `cancelled:` line names the ceiling.
 */
export const CONSOLE_CANCEL_OUTCOME = 'cancelled: the operator stopped the run from the console';

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

/**
 * The outcome line of a run that `detail` ended badly: a run with a recorded
 * cancel names the console first and keeps the detail, and any other failed.
 */
function endedBadly(input: { cancelled: boolean; detail: string }): string {
  return oneLine(
    input.cancelled ? `${CONSOLE_CANCEL_OUTCOME}; ${input.detail}` : `failed: ${input.detail}`,
  );
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
  /** A cancel was recorded before the stream ended. */
  cancelled: boolean;
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
    return endedBadly({
      cancelled: input.cancelled,
      detail: `the API refused the agent token; replace the file MIMIR_AGENT_TOKEN_FILE names (${summary})`,
    });
  }
  if (result.subtype === 'success' && !result.is_error) {
    return input.cancelled ? `${CONSOLE_CANCEL_OUTCOME} (${summary})` : `succeeded: ${summary}`;
  }
  const detail =
    result.subtype === 'success' ? `ended on an API error: ${result.result}` : result.subtype;
  return endedBadly({ cancelled: input.cancelled, detail: `${detail} (${summary})` });
}

/** How a run that ended with a result and a valid total closes. */
function resultState(input: {
  result: SDKResultMessage;
  tokenRejected: boolean;
  cancelled: boolean;
}): RunClosingState {
  if (input.cancelled) {
    return 'cancelled';
  }
  const { result } = input;
  return result.subtype === 'success' && !result.is_error && !input.tokenRejected
    ? 'succeeded'
    : 'failed';
}

/** What ended a run with no result, or none with a valid total, as an outcome detail. */
function unsettledDetail(input: {
  aborted: AbortReason | undefined;
  failure: unknown;
  hadResult: boolean;
  tokenRejected: boolean;
  ceiling: number;
  estimate: number;
  graceMs: number;
}): string {
  if (input.aborted === 'cancel-grace') {
    return `it did not end within its ${Math.round(input.graceMs / 1000)}-second grace period and was aborted`;
  }
  if (input.aborted === 'ceiling') {
    return `the run reached its ${input.ceiling}-token ceiling (estimated ${input.estimate} tokens) and was stopped`;
  }
  if (input.tokenRejected) {
    return 'the API refused the agent token; replace the file MIMIR_AGENT_TOKEN_FILE names';
  }
  if (input.hadResult) {
    return 'the run ended with no valid usage total';
  }
  const message = input.failure instanceof Error ? input.failure.message : 'the stream ended';
  return `the run ended without a result: ${message}`;
}

/** The outcome line for a run that ended with no result, or none with a valid total. */
function describeUnsettled(
  input: Parameters<typeof unsettledDetail>[0] & {
    /** A cancel was recorded before the stream ended. */
    cancelled: boolean;
  },
): { state: RunClosingState; outcome: string } {
  if (input.aborted === 'lost') {
    return { outcome: 'failed: the runner lost the run to another host', state: 'failed' };
  }
  const detail = unsettledDetail(input);
  if (!input.cancelled && input.aborted === 'ceiling') {
    return { outcome: `cancelled: ${detail}`, state: 'cancelled' };
  }
  return {
    outcome: endedBadly({ cancelled: input.cancelled, detail }),
    state: input.cancelled ? 'cancelled' : 'failed',
  };
}

/**
 * The close of a run cancelled before its query was created: it never reached
 * the SDK, so it used nothing and is charged nothing. `detail` keeps what else
 * ended it, such as a clone that did not sync.
 */
function cancelledBeforeQuery(detail?: string) {
  return {
    costEstimateUsd: null,
    outcome:
      detail === undefined
        ? `${CONSOLE_CANCEL_OUTCOME} before its query started`
        : endedBadly({ cancelled: true, detail }),
    state: 'cancelled' as const,
    usage: NO_USAGE,
    usageSettled: true,
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

  /**
   * The runs this process holds, by run id: process-local, so only the
   * process that owns a run can cancel it. An entry is added as soon as
   * admission returns the row and removed once the run's last close attempt
   * has settled.
   */
  const registry = new Map<string, HeldRun>();

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
    return usableRemote(remote) ? { remote } : { reason: 'no-remote' };
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
          timezone: budget.timezone,
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
    // Held before any other await, so a cancel can reach the run from here on;
    // `execute` removes the entry once its last close attempt has settled.
    const held: HeldRun = {
      cancelled: false,
      ended: false,
      onCancel: undefined,
      queryStarted: false,
    };
    registry.set(runId, held);
    const finished = execute({
      held,
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
    held: HeldRun;
    input: StartRunInput;
    remote: string;
    runId: string;
    settings: EnabledAgentSettings;
    token: string;
    tokenIdentity: string;
  }): Promise<RunOutcome> => {
    const { held, input, runId } = run;
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
      const write = await runs.close(runId, options.runnerId, closing);
      return {
        outcome: closing.outcome,
        runId,
        state: write === 'held' ? closing.state : 'lost',
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
      // The slot is this run's now, so no other run directory belongs to a live run.
      await sweepRunDirectories(dataDirectory, runId);
      if (held.cancelled) {
        held.ended = true;
        return await close(cancelledBeforeQuery());
      }
      const sync = await options.syncClone({
        credentials: options.gitCredentials,
        dataDirectory,
        log,
        project: { key: input.project, remote: run.remote },
      });
      if (!sync.ok) {
        held.ended = true;
        // The run never reached the SDK, so it used nothing.
        const reason = `the clone did not sync (${sync.reason}): ${sync.message}`;
        return await close(
          held.cancelled
            ? cancelledBeforeQuery(reason)
            : {
                costEstimateUsd: null,
                outcome: endedBadly({ cancelled: false, detail: reason }),
                state: 'failed',
                usage: NO_USAGE,
                usageSettled: true,
              },
        );
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
      held.ended = true;
      const message = error instanceof Error ? error.message : 'unknown error';
      log(`⚠ host: agent run ${runId} faulted: ${message}`);
      const detail = `the runner faulted: ${message}`;
      // A run cancelled before its query never reached the SDK, so it is charged nothing.
      const closing =
        held.cancelled && !held.queryStarted
          ? cancelledBeforeQuery(detail)
          : {
              costEstimateUsd: null,
              outcome: endedBadly({ cancelled: held.cancelled, detail }),
              state: held.cancelled ? ('cancelled' as const) : ('failed' as const),
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
      // Every close attempt has settled: landed, lost, or thrown.
      registry.delete(runId);
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
      held: HeldRun;
      input: StartRunInput;
      runId: string;
      settings: EnabledAgentSettings;
      token: string;
      tokenIdentity: string;
    };
    sync: Extract<CloneSyncResult, { ok: true }>;
  }): Promise<RunOutcome> => {
    const { abort, meter, owned, run } = context;
    const { held } = run;
    const { budget, dataDirectory } = run.settings;
    const cancelled = () => held.cancelled;
    const gate = createAgentGate({
      cancelled,
      // Not refunded when the CLI then rejects the spawn (past its concurrency
      // limit, say): the allowance stays charged, which only errs toward stopping early.
      chargeSpawn: () => meter.chargeSpawn(),
      cloneRoot: context.sync.directory,
      dataDirectory,
      grantToolNames,
      readerAgentName: READER_AGENT,
    });
    const grant = createRunGrant({
      cancelled,
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
    let grace: ReturnType<typeof setTimeout> | undefined;
    // The stream has ended: a cancel from here on changes nothing, and no grace abort fires.
    const streamEnded = () => {
      held.ended = true;
      held.onCancel = undefined;
      clearTimeout(grace);
    };
    // The last check before the query: no await stands between it and the query's creation.
    if (held.cancelled) {
      held.ended = true;
      return context.close(cancelledBeforeQuery());
    }
    if (context.aborted() === undefined) {
      let query: ReturnType<RunQuery> | undefined;
      try {
        held.queryStarted = true;
        query = options.query({ options: sdkOptions, prompt: run.input.brief.prompt });
        // Once the query exists, a cancel gives the run its grace period to end with a result.
        held.onCancel = () => {
          grace = setTimeout(() => {
            if (result === undefined) {
              abort('cancel-grace');
            }
          }, timing.cancelGraceMs);
        };
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
            held.ended = true;
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
        // Before the close, which may throw.
        streamEnded();
        // A close that throws must not discard a result that already arrived.
        try {
          query?.close?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          log(`⚠ host: agent run ${run.runId}: the query did not close: ${message}`);
        }
      }
    }
    streamEnded();

    const settled =
      result === undefined ? undefined : settledUsage(result.modelUsage, meter.streamed());
    if (result !== undefined && settled !== undefined) {
      return context.close({
        costEstimateUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
        outcome: describeResult({
          cancelled: held.cancelled,
          ceiling: budget.runTokens,
          estimate: meter.total(),
          result,
          settled,
          spawns: meter.spawns(),
          tokenRejected,
        }),
        state: resultState({ cancelled: held.cancelled, result, tokenRejected }),
        usage: settled,
        usageSettled: true,
      });
    }
    // No valid total: the row records the streamed usage and is charged the
    // larger of that and its reservation, which is the run's ceiling.
    const unsettled = describeUnsettled({
      aborted: context.aborted(),
      cancelled: held.cancelled,
      ceiling: budget.runTokens,
      estimate: meter.total(),
      failure,
      graceMs: timing.cancelGraceMs,
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
    const held = holder === undefined ? undefined : registry.get(holder.id);
    const running =
      holder === undefined
        ? null
        : {
            ending: held?.ended ?? false,
            held: held !== undefined,
            run: holder,
            stale: new Date(holder.heartbeat_at).getTime() < staleBefore,
            stopping: held?.cancelled ?? false,
          };
    if (!settings.enabled) {
      return { agent, budget: null, managedPolicy: [], model: null, running };
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
      managedPolicy: await managedPolicy(),
      model: settings.model,
      running,
    };
  };

  const cancelRun: AgentRunner['cancelRun'] = async (runId) => {
    // The registry first, with no await before it.
    const held = registry.get(runId);
    if (held !== undefined) {
      if (held.ended) {
        return { answer: 'ending' };
      }
      if (!held.cancelled) {
        held.cancelled = true;
        held.onCancel?.();
      }
      return { answer: 'cancelling' };
    }
    const row = await runs.get(runId);
    if (row === undefined) {
      return { answer: 'unknown' };
    }
    if (row.state !== 'running') {
      return { answer: 'ended', state: row.state };
    }
    if (row.runner === options.runnerId) {
      return { answer: 'closing' };
    }
    // Stale as recovery judges it: a heartbeat strictly before the cut-off.
    if (new Date(row.heartbeat_at).getTime() < clock().getTime() - timing.staleAfterMs) {
      return { answer: 'stale' };
    }
    return { answer: 'another-host' };
  };

  return { cancelRun, startRun, status };
}
