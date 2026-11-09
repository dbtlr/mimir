import { createServerFn } from '@tanstack/react-start';

import { parseGroomCancelTarget, parseGroomTarget } from '../../server/agent-console-input';
import type { GroomCancelTarget, GroomTarget } from '../../server/agent-console-states';
import { agentConsole } from './engine';

export type {
  AgentActivity,
  AgentBudgetView,
  AgentRunView,
  GroomCancelResult,
  GroomCancelTarget,
  GroomCard,
  GroomRefusal,
  GroomStartResult,
  GroomTarget,
} from '../../server/agent-console-states';

/*
 * The agent runtime's server functions (ADR 0041, MMR-633). They act on the
 * host's agent console, not the Engine; each body is a method of
 * server/agent-console.ts and answers a tagged state rather than throwing for
 * a refusal. The start and the cancel are POSTs, so the host's guards refuse it cross-origin.
 * The query policy lives in agent-queries.ts.
 */

/** One task's agent card: the runtime's state, the day's budget, the running run, and the task's last run. */
export const groomCard = createServerFn({ method: 'GET' })
  .validator((input: GroomTarget) => parseGroomTarget(input))
  .handler(async ({ data }) => (await agentConsole()).card(data));

/** The running run, if any, with its task's title, for a work page's Now. */
export const agentActivity = createServerFn({ method: 'GET' }).handler(async () =>
  (await agentConsole()).activity(),
);

/** Start Groom with agent on one `todo` task: started, or why not. */
export const startGroom = createServerFn({ method: 'POST' })
  .validator((input: GroomTarget) => parseGroomTarget(input))
  .handler(async ({ data }) => (await agentConsole()).startGroom(data));

/** Cancel a running run this host holds: cancelling, or why the cancel changed nothing. */
export const cancelGroom = createServerFn({ method: 'POST' })
  .validator((input: GroomCancelTarget) => parseGroomCancelTarget(input))
  .handler(async ({ data }) => (await agentConsole()).cancelGroom(data));
