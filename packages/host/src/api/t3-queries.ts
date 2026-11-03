import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { leaveFor } from '../lib/leave-for';
import { connectT3, t3Catalog, t3Status } from './fns/t3';
import type { T3ConnectResult } from './fns/t3';

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
