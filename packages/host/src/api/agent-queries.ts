import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { agentActivity, groomCard, startGroom } from './fns/agent';
import type { GroomRefusal, GroomTarget } from './fns/agent';
import { annotationsQuery, nodeQuery } from './node-queries';
import { POLL_MS } from './queries';

/*
 * The agent runtime's reads and its one write (ADR 0041, MMR-633). Their
 * answers are live host state, so they stay out of the offline snapshot
 * (UNPERSISTED_QUERY_KEY_ROOTS in queries.ts holds `agent`). A live run
 * holding the slot is what makes them poll fast.
 */

/** How often a card refetches while a live run holds the slot. */
export const RUNNING_CARD_POLL_MS = 5000;
/** How often the work page's Now looks for a run: fast while one runs, slow otherwise. */
export const RUNNING_ACTIVITY_POLL_MS = 10_000;
export const IDLE_ACTIVITY_POLL_MS = 60_000;

/**
 * One task's agent card. It refetches every 5s while a live run holds the
 * slot, and otherwise at the console's default interval, since polling is how
 * the console sees a run started elsewhere. A stale holder is not live.
 */
export const groomCardQuery = (project: string, task: string) =>
  queryOptions({
    queryFn: () => groomCard({ data: { project, task } }),
    queryKey: ['agent', 'card', project, task],
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.state === 'ready' && data.running !== null && !data.running.stale
        ? RUNNING_CARD_POLL_MS
        : POLL_MS;
    },
  });

/** The running run, for a work page's Now. */
export const agentActivityQuery = queryOptions({
  queryFn: () => agentActivity(),
  queryKey: ['agent', 'activity'],
  refetchInterval: (query) =>
    query.state.data?.running ? RUNNING_ACTIVITY_POLL_MS : IDLE_ACTIVITY_POLL_MS,
});

/**
 * The card's read. When a run on this task leaves `running`, or the task's
 * last ended run changes to one this card never saw running (a fast run, or
 * one started from another tab), the task's record and notes refetch so what
 * the agent wrote appears.
 */
export function useGroomCard(project: string, task: string, enabled: boolean) {
  const qc = useQueryClient();
  const card = useQuery({ ...groomCardQuery(project, task), enabled });
  const data = card.data;
  const ready = data?.state === 'ready' ? data : undefined;
  const runningHere = ready?.running?.task === task;
  // Undefined until a ready read: the first read's last run is not news.
  const lastRunId = ready === undefined ? undefined : (ready.lastRun?.id ?? null);
  const was = useRef<{ runningHere: boolean; lastRunId: string | null | undefined }>({
    lastRunId: undefined,
    runningHere: false,
  });
  useEffect(() => {
    const before = was.current;
    const ended = before.runningHere && !runningHere;
    const newLastRun =
      before.lastRunId !== undefined && lastRunId !== undefined && lastRunId !== before.lastRunId;
    if (ended || newLastRun) {
      void qc.invalidateQueries({ queryKey: nodeQuery(task).queryKey });
      void qc.invalidateQueries({ queryKey: annotationsQuery(task).queryKey });
    }
    was.current = {
      lastRunId: lastRunId === undefined ? before.lastRunId : lastRunId,
      runningHere,
    };
  }, [runningHere, lastRunId, qc, task]);
  return card;
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
