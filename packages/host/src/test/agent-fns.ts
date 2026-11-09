// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { agentActivity, cancelGroom, groomCard, startGroom } from '../api/fns/agent';
import type {
  AgentActivity,
  GroomCancelResult,
  GroomCard,
  GroomStartResult,
} from '../api/fns/agent';

/*
 * The agent server functions served from one state (ADR 0041). A test file
 * that renders the card or a work page's Now mocks the module first —
 * `vi.mock('../api/fns/agent')` — then calls `serveAgent`. The start answers
 * `start`, by default a started run; the cancel answers `cancel`, by default
 * a recorded cancel.
 */

export type AgentWorld = {
  card: GroomCard;
  activity: AgentActivity;
  start: GroomStartResult;
  cancel: GroomCancelResult;
};

/** Answer the agent functions from `world`; the returned state is live. */
export function serveAgent(world: Partial<AgentWorld> = {}): AgentWorld {
  const state: AgentWorld = {
    activity: { running: null },
    cancel: { state: 'cancelling' },
    card: { state: 'unconfigured' },
    start: { runId: 'run-2', state: 'started' },
    ...world,
  };
  vi.mocked(groomCard).mockImplementation(async () => state.card);
  vi.mocked(agentActivity).mockImplementation(async () => state.activity);
  vi.mocked(startGroom).mockImplementation(async () => state.start);
  vi.mocked(cancelGroom).mockImplementation(async () => state.cancel);
  return state;
}
