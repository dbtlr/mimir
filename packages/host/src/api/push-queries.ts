import { queryOptions } from '@tanstack/react-query';

import { pushDevices, pushStatus } from './fns/push';

/*
 * The Web Push channel's reads (ADR 0045, MMR-711): the key and origin a
 * browser subscribes with, and the subscribed devices. They are not board
 * state, so the offline snapshot leaves them out (UNPERSISTED_QUERY_KEY_ROOTS
 * in queries.ts).
 */

/** The key a browser subscribes with and the origin a push opens, or why there is none. */
export const pushStatusQuery = queryOptions({
  queryFn: () => pushStatus(),
  queryKey: ['push', 'status'],
});

/** The subscribed devices, newest first. */
export const pushDevicesQuery = queryOptions({
  queryFn: () => pushDevices(),
  queryKey: ['push', 'devices'],
});

/** The root both reads share, for refetching them together. */
export const PUSH_QUERY_ROOT = ['push'] as const;
