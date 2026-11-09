import type { EngineTree, Grooming } from '@mimir/contract';

import type {
  AgentActivity,
  AgentRunView,
  GroomCancelResult,
  GroomCard,
  GroomRefusal,
} from '../api/fns/agent';
import { ancestorsOf } from './ancestry';
import { ago, clockTime } from './time';

/*
 * What the Groom with agent card shows (ADR 0041, MMR-633), kept apart from
 * the component so each rule is a plain function with its own tests.
 */

/** A token count for people: "0.36M", "2.4M", "10M"; thousands below 0.1M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 100_000) {
    return `${String(Math.round(tokens / 1000))}k`;
  }
  return `${String(Number((tokens / 1_000_000).toFixed(2)))}M`;
}

/** A card read with the runtime ready: it carries the budget, the slot, and the last run. */
export type ReadyCard = Extract<GroomCard, { state: 'ready' }>;

/** A card read that shows a card: everything but `unconfigured`. */
export type ShownCard = Exclude<GroomCard, { state: 'unconfigured' }>;

/** Which card to draw, in the order the states take priority. */
export type AgentCardView =
  | { kind: 'misconfigured'; setting: string; problem: string }
  | { kind: 'disconnected'; tokenModifiedAt: Date }
  | { kind: 'managed-policy'; paths: string[] }
  | { kind: 'running'; run: AgentRunView }
  /** This task's run stopped reporting; a start marks it interrupted and takes the slot. */
  | { kind: 'stale'; run: AgentRunView }
  | { kind: 'busy'; run: AgentRunView }
  | { kind: 'no-remote' }
  | { kind: 'budget' }
  | { kind: 'failed'; run: AgentRunView }
  | { kind: 'groomed'; run: AgentRunView | null }
  | { kind: 'answers'; run: AgentRunView }
  | { kind: 'ready' };

const ENDED_BADLY: ReadonlySet<AgentRunView['state']> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * The card for one task: the runtime's state first, then the slot, the remote,
 * the budget, and the task's own last run and grooming. A stale run holds the
 * slot only until the next start, which marks it interrupted, so it blocks
 * nothing: on another task the card reads on as if the slot were free.
 */
export function deriveAgentCard(card: ShownCard, task: string, grooming: Grooming): AgentCardView {
  if (card.state === 'misconfigured') {
    return {
      kind: 'misconfigured',
      problem: card.problem,
      setting: card.setting,
    };
  }
  if (card.state === 'disconnected') {
    return { kind: 'disconnected', tokenModifiedAt: card.tokenModifiedAt };
  }
  if (card.state === 'managed-policy') {
    return { kind: 'managed-policy', paths: card.paths };
  }
  const { running, lastRun } = card;
  if (running !== null && running.task === task) {
    return { kind: running.stale ? 'stale' : 'running', run: running };
  }
  if (running !== null && !running.stale) {
    return { kind: 'busy', run: running };
  }
  if (!card.hasRemote) {
    return { kind: 'no-remote' };
  }
  if (card.budget.remainingTokens < card.budget.runTokens) {
    return { kind: 'budget' };
  }
  if (lastRun !== null && ENDED_BADLY.has(lastRun.state)) {
    return { kind: 'failed', run: lastRun };
  }
  const succeeded = lastRun?.state === 'succeeded' ? lastRun : null;
  if (grooming === 'groomed') {
    return { kind: 'groomed', run: succeeded };
  }
  if (grooming === 'needs_answers' && succeeded !== null) {
    return { kind: 'answers', run: succeeded };
  }
  return { kind: 'ready' };
}

/**
 * When the budget day resets: the time in the reader's zone, and the budget
 * day's own zone, whose midnight it is. "7:00 PM (midnight UTC)".
 */
export function resetText(resetsAt: Date, timezone: string): string {
  return `${clockTime(resetsAt)} (midnight ${timezone})`;
}

/** The worded reason a start did not happen. */
export function refusalText(refusal: GroomRefusal): string {
  switch (refusal.reason) {
    case 'unconfigured': {
      return 'Agent runs are not set up on this host.';
    }
    case 'misconfigured': {
      return `Agent runs are not set up: ${refusal.setting} is ${refusal.problem}.`;
    }
    case 'disconnected': {
      return 'The agent token was refused. Replace the file MIMIR_AGENT_TOKEN_FILE names with a fresh token.';
    }
    case 'managed-policy': {
      return `Claude Code managed settings exist on the host (${refusal.paths.join(', ')}) and would override the run's limits. Remove them to run agents.`;
    }
    case 'task-not-found': {
      return 'This task no longer exists.';
    }
    case 'task-not-todo': {
      return `Only a todo task can be groomed, and this one is ${refusal.lifecycle}.`;
    }
    case 'no-remote': {
      return 'The project has no remote for the agent to read. Set one with mimir update and --remote.';
    }
    case 'budget': {
      return `A run reserves ${formatTokens(refusal.runTokens)} tokens and only ${formatTokens(Math.max(0, refusal.dailyTokens - refusal.usedTokens))} are left today. The budget resets at ${resetText(refusal.resetsAt, refusal.timezone)}.`;
    }
    default: {
      return refusal.running === null
        ? 'Another run was holding the slot and has just ended. Try again.'
        : `Agents run one at a time, and one started grooming ${refusal.running.task} ${ago(refusal.running.startedAt)}.`;
    }
  }
}

/** A cancel answer that recorded nothing: the sentence saying what happened instead. */
export function cancelAnswerText(
  answer: Exclude<GroomCancelResult, { state: 'cancelling' }>,
): string {
  switch (answer.state) {
    case 'ending': {
      return 'The run is already finishing on its own.';
    }
    case 'ended': {
      return `The run already ended (${answer.runState}).`;
    }
    case 'unknown': {
      return 'This run no longer exists.';
    }
    case 'stale': {
      return "The run's host stopped reporting. Starting a new run clears it.";
    }
    case 'closing': {
      return 'This host could not close the run. It stops reporting within two minutes, and starting a new run then clears it.';
    }
    default: {
      return 'Another host is running this. Try again shortly, or wait for it to finish.';
    }
  }
}

/** The running run a work page reads, with its task's title. */
export type AgentRun = NonNullable<AgentActivity['running']>;

/** Whether a running run's task sits in a work page's scope (a project, or a container's subtree). */
export function runInScope(
  run: AgentRunView,
  projectKey: string,
  container?: { id: string; tree: EngineTree | undefined },
): boolean {
  if (run.project !== projectKey) {
    return false;
  }
  if (container === undefined) {
    return true;
  }
  if (container.tree === undefined) {
    return false;
  }
  return ancestorsOf(container.tree, run.task)?.some((a) => a.id === container.id) ?? false;
}

/** The running run a work page shows, or null when none is in its scope. */
export function scopedRun(
  activity: AgentActivity | undefined,
  projectKey: string,
  container?: { id: string; tree: EngineTree | undefined },
): AgentRun | null {
  const run = activity?.running ?? null;
  return run !== null && runInScope(run, projectKey, container) ? run : null;
}

/** Used share of a total, as a CSS percentage clamped to 0-100. */
export function sharePercent(part: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (part / total) * 100));
}
