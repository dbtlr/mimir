import type { Engine } from '@mimir/contract';
import type { Run, RunStore } from '@mimir/core';

import { isEngineRefusal } from '../api/errors';
import type {
  AgentActivity,
  AgentConsole,
  AgentRunView,
  GroomPanel,
  GroomRefusal,
  GroomStartResult,
} from './agent-console-states';
import type { AgentRunner, AgentStatus, RunningRun, RunOutcome, RunRefusal } from './agent-runner';
import { usageTotal } from './agent-usage';
import { groomableTarget, groomBrief } from './groom-brief';

/*
 * The console's agent surface (ADR 0041, MMR-633), beside the Engine like the
 * T3 adapter: the runner's status and refusals as the console's tagged
 * states. A start answers once the run is admitted; the run settles in the
 * background and its outcome goes to the host's log.
 */

export type AgentConsoleOptions = {
  agent: AgentRunner;
  /** The task's last ended run, for its card. */
  runs: Pick<RunStore, 'lastEnded'>;
  /** Reads the project's remote and the running run's task title. */
  engine: Pick<Engine, 'getNode'>;
  log: (line: string) => void;
};

// Fails to compile when the runner gains a refusal reason the console does not read.
const coversEveryRefusal: Exclude<RunRefusal['reason'], GroomRefusal['reason']> extends never
  ? true
  : false = true;
void coversEveryRefusal;

/** One run row as the console shows it. */
function runView(run: Run, stale: boolean): AgentRunView {
  return {
    endedAt: run.ended_at === null ? null : new Date(run.ended_at),
    heartbeatAt: new Date(run.heartbeat_at),
    id: run.id,
    kind: run.kind,
    model: run.model,
    outcome: run.outcome,
    project: run.project,
    reservedTokens: run.reserved_tokens,
    stale,
    startedAt: new Date(run.started_at),
    state: run.state,
    task: run.task,
    usedTokens: usageTotal({
      cacheReadTokens: run.cache_read_tokens,
      cacheWriteTokens: run.cache_write_tokens,
      inputTokens: run.input_tokens,
      outputTokens: run.output_tokens,
    }),
  };
}

const runningView = (running: RunningRun | null) =>
  running === null ? null : runView(running.run, running.stale);

/** The runner's refusal with its instants as `Date`s, and without the `started` flag. */
function groomRefusal(refusal: RunRefusal): GroomRefusal {
  switch (refusal.reason) {
    case 'unconfigured':
    case 'disconnected':
    case 'task-not-found':
    case 'no-remote': {
      return { reason: refusal.reason };
    }
    case 'misconfigured': {
      return { problem: refusal.problem, reason: 'misconfigured', setting: refusal.setting };
    }
    case 'managed-policy': {
      return { paths: refusal.paths, reason: 'managed-policy' };
    }
    case 'task-not-todo': {
      return { lifecycle: refusal.lifecycle, reason: 'task-not-todo' };
    }
    case 'budget': {
      return {
        dailyTokens: refusal.dailyTokens,
        reason: 'budget',
        resetsAt: refusal.resetsAt,
        runTokens: refusal.runTokens,
        usedTokens: refusal.usedTokens,
      };
    }
    case 'busy': {
      const { running } = refusal;
      return {
        reason: 'busy',
        running:
          running === null
            ? null
            : { id: running.id, startedAt: new Date(running.startedAt), task: running.task },
      };
    }
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

/** The status, or null while agent runs are unconfigured, including a ready state with no budget. */
function configured(status: AgentStatus) {
  const { agent, budget, model } = status;
  return agent.state === 'ready' && budget !== null && model !== null
    ? { budget, model, running: status.running, tokenModifiedAt: agent.tokenModifiedAt }
    : null;
}

/** Create the console's agent surface. `openHost` builds one beside the runner. */
export function createAgentConsole(options: AgentConsoleOptions): AgentConsole {
  const { agent, engine, log, runs } = options;

  /** A node's field through `read`, or null when the Engine refuses the lookup. */
  const lookup = async <T>(
    id: string,
    read: (node: Awaited<ReturnType<Engine['getNode']>>) => T,
  ) => {
    try {
      return read(await engine.getNode({ facets: [], id }));
    } catch (error) {
      if (isEngineRefusal(error)) {
        return null;
      }
      throw error;
    }
  };

  const hasRemote = async (project: string) =>
    ((await lookup(project, (node) => node.remote?.trim())) ?? '') !== '';

  /** Log the run's outcome line once it settles; `finished` never rejects. */
  const logOutcome = async (task: string, finished: Promise<RunOutcome>) => {
    const { outcome, runId, state } = await finished;
    log(`host: agent run ${runId} on ${task} (${state}): ${outcome}`);
  };

  const lastRun = async (target: { project: string; task: string }) => {
    const run = await runs.lastEnded(target.task);
    return run === undefined || run.project !== target.project ? null : runView(run, false);
  };

  const panel: AgentConsole['panel'] = async (target): Promise<GroomPanel> => {
    const status = await agent.status();
    const { agent: state } = status;
    if (state.state === 'misconfigured') {
      return { problem: state.problem, setting: state.setting, state: 'misconfigured' };
    }
    if (state.state === 'disconnected') {
      return { reason: state.reason, state: 'disconnected' };
    }
    const ready = configured(status);
    if (ready === null) {
      return { state: 'unconfigured' };
    }
    return {
      budget: ready.budget,
      hasRemote: await hasRemote(target.project),
      lastRun: await lastRun(target),
      model: ready.model,
      running: runningView(ready.running),
      state: 'ready',
      tokenModifiedAt: ready.tokenModifiedAt,
    };
  };

  const activity: AgentConsole['activity'] = async (): Promise<AgentActivity> => {
    const ready = configured(await agent.status());
    const running = ready === null ? null : runningView(ready.running);
    if (running === null) {
      return { running: null };
    }
    return { running: { ...running, taskTitle: await lookup(running.task, (node) => node.title) } };
  };

  const startGroom: AgentConsole['startGroom'] = async (target): Promise<GroomStartResult> => {
    // The brief carries the ids, so ids that are not a task in its project never reach a run.
    if (!groomableTarget(target)) {
      return { refusal: { reason: 'task-not-found' }, state: 'refused' };
    }
    const start = await agent.startRun({
      brief: groomBrief(target),
      kind: 'groom',
      project: target.project,
      task: target.task,
      trigger: 'console',
    });
    if (!start.started) {
      return { refusal: groomRefusal(start), state: 'refused' };
    }
    // Not awaited: the start answers now, and the run settles in the background.
    void logOutcome(target.task, start.finished);
    return { runId: start.runId, state: 'started' };
  };

  return { activity, panel, startGroom };
}
