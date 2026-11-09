import type { Query } from '@tanstack/react-query';

import {
  agentActivityQuery,
  IDLE_ACTIVITY_POLL_MS,
  RUNNING_ACTIVITY_POLL_MS,
} from '../api/agent-queries';
import type { AgentActivity } from '../api/fns/agent';
import { runningActivity } from './agent-fixtures';

/** The activity query's polling interval for one answer. */
function activityInterval(data: AgentActivity | undefined) {
  const interval = agentActivityQuery.refetchInterval;
  if (typeof interval !== 'function') {
    throw new TypeError('the activity query polls by its answer');
  }
  return interval({ state: { data } } as Query<AgentActivity, Error, AgentActivity, string[]>);
}

describe('agent activity polling', () => {
  it('polls fast only while a live run holds the slot', () => {
    expect(activityInterval(runningActivity())).toBe(RUNNING_ACTIVITY_POLL_MS);
  });

  it('polls at the idle rate when nothing runs or the holder went stale', () => {
    expect(activityInterval({ running: null })).toBe(IDLE_ACTIVITY_POLL_MS);
    expect(activityInterval(runningActivity({ stale: true }))).toBe(IDLE_ACTIVITY_POLL_MS);
    expect(activityInterval(undefined)).toBe(IDLE_ACTIVITY_POLL_MS);
  });
});
