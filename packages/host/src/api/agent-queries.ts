import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { agentActivity, groomPanel, startGroom } from './fns/agent';
import type { GroomRefusal, GroomTarget } from './fns/agent';
import { annotationsQuery, nodeQuery } from './node-queries';

/*
 * The agent runtime's reads and its one write (ADR 0041, MMR-633). Their
 * answers are live host state, so they stay out of the offline snapshot
 * (UNPERSISTED_QUERY_KEY_ROOTS in queries.ts holds `agent`). A run holding the
 * slot is what makes them poll fast.
 */

/** How often a card refetches while a run holds the slot. */
export const RUNNING_PANEL_POLL_MS = 5000;
/** How often the work page's Now looks for a run: fast while one runs, slow otherwise. */
export const RUNNING_ACTIVITY_POLL_MS = 10_000;
export const IDLE_ACTIVITY_POLL_MS = 60_000;

/** One task's agent card; it refetches every 5s only while a run holds the slot. */
export const groomPanelQuery = (project: string, task: string) =>
  queryOptions({
    queryFn: () => groomPanel({ data: { project, task } }),
    queryKey: ['agent', 'panel', project, task],
    refetchInterval: (query) =>
      query.state.data?.state === 'ready' && query.state.data.running !== null
        ? RUNNING_PANEL_POLL_MS
        : false,
  });

/** The running run, for a work page's Now. */
export const agentActivityQuery = queryOptions({
  queryFn: () => agentActivity(),
  queryKey: ['agent', 'activity'],
  refetchInterval: (query) =>
    query.state.data?.running ? RUNNING_ACTIVITY_POLL_MS : IDLE_ACTIVITY_POLL_MS,
});

/**
 * The card's read. When a run on this task leaves `running`, the task's record
 * and notes refetch so what the agent wrote appears.
 */
export function useGroomPanel(project: string, task: string, enabled: boolean) {
  const qc = useQueryClient();
  const panel = useQuery({ ...groomPanelQuery(project, task), enabled });
  const data = panel.data;
  const runningHere = data?.state === 'ready' && data.running?.task === task;
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !runningHere) {
      void qc.invalidateQueries({ queryKey: nodeQuery(task).queryKey });
      void qc.invalidateQueries({ queryKey: annotationsQuery(task).queryKey });
    }
    was.current = runningHere;
  }, [runningHere, qc, task]);
  return panel;
}

/**
 * Start Groom with agent. A refusal is a state handed to `onRefused`; a start
 * (or a refusal, which says the card was stale) refreshes the card and the
 * work pages' activity.
 */
export function useStartGroom(onRefused: (refusal: GroomRefusal | undefined) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: GroomTarget) => startGroom({ data: target }),
    onError: (err: Error) => toast.error(err.message),
    onSuccess: (answer) => {
      onRefused(answer.state === 'refused' ? answer.refusal : undefined);
      void qc.invalidateQueries({ queryKey: ['agent'] });
    },
  });
}
