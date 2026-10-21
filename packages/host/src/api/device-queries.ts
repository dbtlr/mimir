import { queryOptions } from '@tanstack/react-query';

import { lookupPairing, pairedDevices, pendingPairings } from './fns/devices';

/*
 * The device pages' reads (MMR-585): the requests waiting for the operator,
 * the paired devices, and the request a typed code names. They are not board
 * state, so the offline snapshot leaves them out (UNPERSISTED_QUERY_KEY_ROOTS
 * in queries.ts).
 */

/** How often the waiting list refreshes: the operator is watching for a client's request. */
export const PENDING_POLL_MS = 2000;

/** Requests awaiting a decision, polled fast so a client's new request appears while the page is open. */
export const pendingPairingsQuery = queryOptions({
  queryFn: () => pendingPairings(),
  queryKey: ['devices', 'pending'],
  refetchInterval: PENDING_POLL_MS,
});

/** The active paired devices. */
export const pairedDevicesQuery = queryOptions({
  queryFn: () => pairedDevices(),
  queryKey: ['devices', 'paired'],
});

/** The waiting request a code names, or null. A decision changes the answer, so it is never reused stale. */
export const pairingLookupQuery = (code: string) =>
  queryOptions({
    queryFn: () => lookupPairing({ data: { code } }),
    queryKey: ['devices', 'lookup', code],
    refetchInterval: false,
    retry: false,
    staleTime: 0,
  });
