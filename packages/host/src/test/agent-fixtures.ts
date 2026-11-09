// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { AgentActivity, AgentBudgetView, AgentRunView, GroomCard } from '../api/fns/agent';

/*
 * The agent runtime's console reads as the host answers them, with `Date`
 * instants (ADR 0041, MMR-633). A builder fills every field; a case overrides
 * what it is about.
 */

/** A run on MMR-640, started at the fixture instant, still running. */
export function agentRun(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    cancellable: false,
    // A running run counts its reservation until it settles.
    chargedTokens: 4_000_000,
    endedAt: null,
    heartbeatAt: new Date('2026-06-01T10:00:00.000Z'),
    id: 'run-1',
    kind: 'groom',
    model: 'claude-opus-5-5',
    outcome: null,
    project: 'MMR',
    reservedTokens: 4_000_000,
    stale: false,
    startedAt: new Date('2026-06-01T10:00:00.000Z'),
    state: 'running',
    stopDetail: null,
    stoppedFromConsole: false,
    stopping: false,
    task: 'MMR-640',
    usedTokens: 360_000,
    ...overrides,
  };
}

/** A run that ended and settled, with its outcome line. */
export function endedRun(
  state: AgentRunView['state'],
  outcome: string,
  overrides: Partial<AgentRunView> = {},
): AgentRunView {
  return agentRun({
    chargedTokens: 370_000,
    endedAt: new Date('2026-06-01T10:10:00.000Z'),
    outcome,
    state,
    usedTokens: 370_000,
    ...overrides,
  });
}

/** 2.4M of 10M used, a 4M run, resetting at local midnight-ish (7:00 PM in the suite's zone is midnight UTC). */
export function agentBudget(overrides: Partial<AgentBudgetView> = {}): AgentBudgetView {
  return {
    dailyTokens: 10_000_000,
    remainingTokens: 7_600_000,
    resetsAt: new Date('2026-06-02T00:00:00.000Z'),
    runTokens: 4_000_000,
    timezone: 'UTC',
    usedTokens: 2_400_000,
    ...overrides,
  };
}

/** A ready runtime with a free slot and a remote; override the slot, last run, or budget. */
export function readyCard(
  overrides: Partial<Extract<GroomCard, { state: 'ready' }>> = {},
): Extract<GroomCard, { state: 'ready' }> {
  return {
    budget: agentBudget(),
    hasRemote: true,
    lastRun: null,
    model: 'claude-opus-5-5',
    running: null,
    state: 'ready',
    tokenModifiedAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** The activity read with a run on a task titled `title`. */
export function runningActivity(
  overrides: Partial<AgentRunView> = {},
  taskTitle: string | null = 'Show each clone’s last sync time',
): AgentActivity {
  return { running: { ...agentRun(overrides), taskTitle } };
}
