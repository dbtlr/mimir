import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { leaveFor } from '../lib/leave-for';
import { connectT3, launchT3, t3Catalog, t3Origin, t3Status } from './fns/t3';
import type { T3ConnectResult, T3LaunchInput, T3LaunchResult } from './fns/t3';
import { useInvalidateOnWrite } from './mutations';

/*
 * The T3 Code integration's reads and its one write (ADR 0040). Their answers
 * come from another service, so they stay out of the offline snapshot
 * (UNPERSISTED_QUERY_KEY_ROOTS in queries.ts holds `t3`).
 */

/** The Devices page's T3 state; a failure of T3 is a state, not an error. */
export const t3StatusQuery = queryOptions({
  queryFn: () => t3Status(),
  queryKey: ['t3', 'status'],
});

/** The systems one project can launch onto. */
export const t3CatalogQuery = (project: string) =>
  queryOptions({
    queryFn: () => t3Catalog({ data: { project } }),
    queryKey: ['t3', 'catalog', project],
  });

/**
 * The Open in T3 origin: null when the feature is not configured. It changes
 * only with the host's settings, so it is read once and kept.
 */
export const t3OriginQuery = queryOptions({
  queryFn: () => t3Origin(),
  queryKey: ['t3', 'origin'],
  refetchInterval: false,
  staleTime: 5 * 60_000,
});

/**
 * Launch a task in a new T3 thread (ADR 0040, Launch). Every answer is a
 * state, handed to `onAnswer`; only a thrown failure toasts here. The task's
 * reads and the catalog refresh after any answer, since the launch may have
 * queued the task or changed what T3 offers.
 */
export function useLaunchT3(
  onAnswer: (answer: T3LaunchResult, input: T3LaunchInput, retry: () => void) => void,
) {
  const qc = useQueryClient();
  const invalidateWrites = useInvalidateOnWrite();
  // A Retry sends the same input, attempt included, through the same mutation.
  const send = useRef<(input: T3LaunchInput) => void>(() => {});
  const mutation = useMutation({
    mutationFn: (input: T3LaunchInput) => launchT3({ data: input }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: async () => {
      await Promise.all([
        invalidateWrites(),
        qc.invalidateQueries({ queryKey: ['t3', 'catalog'] }),
      ]);
    },
    // The answer is announced before the refetches land: they may unmount the
    // control that started the launch, since a queued task offers no launch.
    onSuccess: (answer, input) => {
      onAnswer(answer, input, () => {
        send.current(input);
      });
    },
  });
  useEffect(() => {
    send.current = mutation.mutate;
  }, [mutation.mutate]);
  return mutation;
}

/**
 * Connect (or Reconnect) T3. An authorization URL sends the browser to T3's
 * connect screen; any other answer is a state, handed to `onRefused` while
 * the T3 reads refresh.
 */
export function useConnectT3(
  onRefused: (answer: Exclude<T3ConnectResult, { state: 'authorize' }>) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => connectT3(),
    onError: (err: Error) => toast.error(err.message),
    onSuccess: (answer) => {
      if (answer.state === 'authorize') {
        leaveFor(answer.url);
        return;
      }
      onRefused(answer);
      void qc.invalidateQueries({ queryKey: ['t3'] });
    },
  });
}
