import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';

import {
  agentActivityQuery,
  IDLE_ACTIVITY_POLL_MS,
  useCancelGroom,
  RUNNING_ACTIVITY_POLL_MS,
} from '../api/agent-queries';
import { cancelGroom } from '../api/fns/agent';
import type { AgentActivity } from '../api/fns/agent';
import { runningActivity } from './agent-fixtures';
import { serveAgent } from './agent-fns';

vi.mock('../api/fns/agent');

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

describe('useCancelGroom', () => {
  it('hands the answer over and invalidates the agent queries', async () => {
    serveAgent({ cancel: { state: 'unknown' } });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const onAnswer = vi.fn();
    const { result } = renderHook(() => useCancelGroom(onAnswer), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    result.current.mutate({ runId: 'run-1' });
    await waitFor(() => {
      expect(onAnswer).toHaveBeenCalledWith({ state: 'unknown' });
    });
    expect(cancelGroom).toHaveBeenCalledWith({ data: { runId: 'run-1' } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agent'] });
  });
});
