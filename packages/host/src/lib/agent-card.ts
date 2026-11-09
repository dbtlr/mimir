import type { EngineTree, Grooming } from '@mimir/contract';

import type { AgentActivity, AgentRunView, GroomPanel, GroomRefusal } from '../api/fns/agent';
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

/** A panel with the runtime ready: it carries the budget, the slot, and the last run. */
export type ReadyPanel = Extract<GroomPanel, { state: 'ready' }>;

/** A panel that shows a card: everything but `unconfigured`. */
export type ShownPanel = Exclude<GroomPanel, { state: 'unconfigured' }>;

/** Which card to draw, in the order the states take priority. */
export type AgentCardView =
  | { kind: 'misconfigured'; setting: string; problem: string }
  | { kind: 'disconnected' }
  | { kind: 'running'; run: AgentRunView }
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
 * the budget, and the task's own last run and grooming.
 */
export function deriveAgentCard(
  panel: ShownPanel,
  task: string,
  grooming: Grooming,
): AgentCardView {
  if (panel.state === 'misconfigured') {
    return {
      kind: 'misconfigured',
      problem: panel.problem,
      setting: panel.setting,
    };
  }
  if (panel.state === 'disconnected') {
    return { kind: 'disconnected' };
  }
  const { running, lastRun } = panel;
  if (running !== null) {
    return running.task === task
      ? { kind: 'running', run: running }
      : { kind: 'busy', run: running };
  }
  if (!panel.hasRemote) {
    return { kind: 'no-remote' };
  }
  if (panel.budget.remainingTokens < panel.budget.runTokens) {
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
      return "The project has no remote for the agent to read. Set one with mimir update and --remote.";
    }
    case 'budget': {
      return `A run reserves ${formatTokens(refusal.runTokens)} tokens and only ${formatTokens(Math.max(0, refusal.dailyTokens - refusal.usedTokens))} are left today. The budget resets at ${clockTime(refusal.resetsAt)}.`;
    }
    default: {
      return refusal.running === null
        ? 'Another run was holding the slot and has just ended. Try again.'
        : `Agents run one at a time, and one has been grooming ${refusal.running.task} since ${ago(refusal.running.startedAt)}.`;
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
