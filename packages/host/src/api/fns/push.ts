import { createServerFn } from '@tanstack/react-start';

import {
  parsePushEndpointInput,
  parsePushKindInput,
  parsePushSubscribeInput,
} from '../../server/push-input';
import type { PushEndpointInput, PushKindInput, PushSubscribeInput } from '../../server/push-input';
import { pushNotifications, requestOriginHeader } from './engine';

export type {
  PushDevice,
  PushDeviceList,
  PushResetResult,
  PushEventKind,
  PushSendTestResult,
  PushSetKindResult,
  PushStatus,
  PushSubscribeResult,
  PushUnsubscribeResult,
} from '../../server/push-states';
export type { PushEndpointInput, PushKindInput, PushSubscribeInput } from '../../server/push-input';

/*
 * The Web Push channel's server functions (ADR 0045, the MMR-709
 * refinement). They act on the host's push channel, not the Engine; each body
 * is an operation of server/push-channel.ts. Each answers a tagged state
 * rather than throwing for a push service's failure. Reads are GETs and
 * writes are POSTs.
 */

/** The key a browser subscribes with and the origin a push opens, or why there is none. */
export const pushStatus = createServerFn({ method: 'GET' }).handler(async () =>
  (await pushNotifications()).status(),
);

/** The subscribed devices, newest first, without their keys. */
export const pushDevices = createServerFn({ method: 'GET' }).handler(async () =>
  (await pushNotifications()).list(),
);

/** Subscribe this browser; the request's `Origin` must be the console's. */
export const subscribePush = createServerFn({ method: 'POST' })
  .validator((input: PushSubscribeInput) => parsePushSubscribeInput(input))
  .handler(async ({ data }) => (await pushNotifications()).subscribe(data, requestOriginHeader()));

/** Remove one device's subscription. */
export const unsubscribePush = createServerFn({ method: 'POST' })
  .validator((input: PushEndpointInput) => parsePushEndpointInput(input))
  .handler(async ({ data }) => (await pushNotifications()).unsubscribe(data.endpoint));

/** Send one test push to one device. */
export const sendTestPush = createServerFn({ method: 'POST' })
  .validator((input: PushEndpointInput) => parsePushEndpointInput(input))
  .handler(async ({ data }) => (await pushNotifications()).sendTest(data.endpoint));

/** Mute or unmute one kind on one device (ADR 0045, the MMR-712 refinement). */
export const setPushKind = createServerFn({ method: 'POST' })
  .validator((input: PushKindInput) => parsePushKindInput(input))
  .handler(async ({ data }) =>
    (await pushNotifications()).setKind(data.endpoint, data.kind, data.muted),
  );

/** Replace the VAPID key; every device subscribes again. */
export const resetPushKey = createServerFn({ method: 'POST' }).handler(async () =>
  (await pushNotifications()).resetKey(),
);
