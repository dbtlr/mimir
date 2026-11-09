import type { AgentDisconnection, AgentMisconfiguration } from './agent-states';

/*
 * What the console reads from and gets back from the agent runtime (ADR 0041,
 * MMR-633), in the T3 integration's pattern: tagged states, never a thrown
 * failure for something the operator can fix. The console's client bundle
 * loads this file, so it imports types only.
 */

/** A run's lifecycle as the runs table records it. */
export type AgentRunState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/** One run as the console shows it. */
export type AgentRunView = {
  id: string;
  project: string;
  task: string;
  kind: 'groom';
  state: AgentRunState;
  /** The model id the run used. */
  model: string;
  /**
   * Tokens processed so far, or the settled total once the run ended: input,
   * cache reads, cache writes, and output.
   */
  usedTokens: number;
  /** The run's token ceiling, reserved against the day's budget at admission. */
  reservedTokens: number;
  startedAt: Date;
  endedAt: Date | null;
  heartbeatAt: Date;
  /** The one line the runner recorded when the run ended; null while it runs. */
  outcome: string | null;
  /** A running run whose heartbeat is older than the stale window: its host most likely stopped. */
  stale: boolean;
};

/** The day's agent budget. */
export type AgentBudgetView = {
  dailyTokens: number;
  /** What one run reserves at admission: a start needs this much left. */
  runTokens: number;
  usedTokens: number;
  remainingTokens: number;
  /** The next midnight in `timezone`. */
  resetsAt: Date;
  timezone: string;
};

/**
 * The agent card on one task's page. `unconfigured` hides the card. The card
 * shows only on `todo` tasks; the page decides that from the task itself.
 */
export type GroomCard =
  | { state: 'unconfigured' }
  | ({ state: 'misconfigured' } & AgentMisconfiguration)
  /** The API refused the token; `tokenModifiedAt` is the refused file's modification time. */
  | { state: 'disconnected'; reason: AgentDisconnection; tokenModifiedAt: Date }
  /** Claude Code managed settings exist on the host, so every start would be refused. */
  | { state: 'managed-policy'; paths: string[] }
  | {
      state: 'ready';
      /** The model a new run uses. */
      model: string;
      /** When the token file last changed: the card shows its age, since a setup-token token lasts one year. */
      tokenModifiedAt: Date;
      budget: AgentBudgetView;
      /** The run holding the one running slot, on this task or another; null when the slot is free. */
      running: AgentRunView | null;
      /** This task's most recent run that has ended; null when it has none. */
      lastRun: AgentRunView | null;
      /** The task's project has a remote for the host to clone. */
      hasRemote: boolean;
    };

/** The running run for a work page's Now, with its task's title. */
export type AgentActivity = {
  running: (AgentRunView & { taskTitle: string | null }) | null;
};

/** Why a start did not happen: the runner's refusal, with its instants as `Date`s. */
export type GroomRefusal =
  | { reason: 'unconfigured' }
  | ({ reason: 'misconfigured' } & AgentMisconfiguration)
  | { reason: 'disconnected' }
  /** Claude Code managed settings exist on the host and would override the run's options. */
  | { reason: 'managed-policy'; paths: string[] }
  | { reason: 'task-not-found' }
  | { reason: 'task-not-todo'; lifecycle: string }
  | { reason: 'no-remote' }
  | {
      reason: 'budget';
      usedTokens: number;
      runTokens: number;
      dailyTokens: number;
      resetsAt: Date;
      /** The budget day's IANA time zone, whose midnight `resetsAt` is. */
      timezone: string;
    }
  /** Another run holds the slot; `running` is null when it ended before it could be read. */
  | { reason: 'busy'; running: { id: string; task: string; startedAt: Date } | null };

/** What Groom with agent answers. A started run settles in the background. */
export type GroomStartResult =
  | { state: 'started'; runId: string }
  | { state: 'refused'; refusal: GroomRefusal };

/** One task in one project: what the card reads and what a start acts on. */
export type GroomTarget = { project: string; task: string };

/**
 * The host's console-facing agent surface (MMR-633), beside the Engine like
 * the T3 adapter. Each method answers a tagged state.
 */
export type AgentConsole = {
  card: (target: GroomTarget) => Promise<GroomCard>;
  activity: () => Promise<AgentActivity>;
  startGroom: (target: GroomTarget) => Promise<GroomStartResult>;
};
