// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { agentActivity, groomCard, startGroom } from '../api/fns/agent';
import type { AgentActivity, GroomCard, GroomStartResult } from '../api/fns/agent';

/*
 * The agent server functions served from one state (ADR 0041). A test file
 * that renders the card or a work page's Now mocks the module first —
 * `vi.mock('../api/fns/agent')` — then calls `serveAgent`. The start answers
 * `start`, by default a started run.
 */

export type AgentWorld = {
  card: GroomCard;
  activity: AgentActivity;
  start: GroomStartResult;
};

/** Answer the agent functions from `world`; the returned state is live. */
export function serveAgent(world: Partial<AgentWorld> = {}): AgentWorld {
  const state: AgentWorld = {
    activity: { running: null },
    card: { state: 'unconfigured' },
    start: { runId: 'run-2', state: 'started' },
    ...world,
  };
  vi.mocked(groomCard).mockImplementation(async () => state.card);
  vi.mocked(agentActivity).mockImplementation(async () => state.activity);
  vi.mocked(startGroom).mockImplementation(async () => state.start);
  return state;
}
