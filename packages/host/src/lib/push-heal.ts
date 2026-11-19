import type { PushDeviceList, PushStatus } from '../api/fns/push';
import type { BrowserSubscription, PushPermission, ThisDeviceRecord } from './push-browser';
import { sameEndpoint } from './push-endpoint';

/*
 * Healing this browser's subscription when the console opens (ADR 0045,
 * MMR-709 and MMR-711). The console compares what the browser holds with what
 * the host serves and keeps. One decision, one action, so each case is proved
 * once here.
 */

export type HealAction =
  | { kind: 'none' }
  /** Subscribe again with the served key and send it: the host reset its key, or the browser lost the subscription. */
  | { kind: 'resubscribe'; reason: 'key_changed' | 'dropped' }
  /** The browser replaced its subscription: send the new one and drop the record's old endpoint. */
  | { kind: 'adopt'; staleEndpoint: string }
  /** The host no longer lists it, so another device removed it: drop it here and stay off. */
  | { kind: 'mark_removed' };

export type HealInput = {
  status: PushStatus;
  devices: PushDeviceList;
  pushSupported: boolean;
  permission: PushPermission;
  record: ThisDeviceRecord | null;
  /** The browser's own subscription now. */
  subscription: BrowserSubscription | null;
};

/** Whether the healer has anything to look at: a browser that turned notifications on and still may. */
export function healApplies(input: {
  status: PushStatus | undefined;
  pushSupported: boolean;
  permission: PushPermission;
  record: ThisDeviceRecord | null;
}): boolean {
  return (
    input.status?.state === 'ready' &&
    input.pushSupported &&
    input.permission === 'granted' &&
    input.record?.state === 'on'
  );
}

/**
 * The one thing to do. A removal never re-subscribes: a Remove from another
 * device must stick until the operator turns notifications on here again. A
 * browser that does not say which key it subscribed with is judged by its
 * row's `currentKey`. Endpoints compare as the host stores them.
 */
export function decideHeal(input: HealInput): HealAction {
  const { status, devices, record, subscription } = input;
  if (
    !healApplies(input) ||
    status.state !== 'ready' ||
    record?.state !== 'on' ||
    devices.state !== 'listed'
  ) {
    return { kind: 'none' };
  }
  if (subscription === null) {
    return { kind: 'resubscribe', reason: 'dropped' };
  }
  const keyKnown = subscription.applicationServerKey !== null;
  if (keyKnown && subscription.applicationServerKey !== status.publicKey) {
    return { kind: 'resubscribe', reason: 'key_changed' };
  }
  if (!sameEndpoint(subscription.endpoint, record.endpoint)) {
    return { kind: 'adopt', staleEndpoint: record.endpoint };
  }
  const row = devices.devices.find((device) =>
    sameEndpoint(device.endpoint, subscription.endpoint),
  );
  if (row === undefined) {
    return { kind: 'mark_removed' };
  }
  return !keyKnown && !row.currentKey
    ? { kind: 'resubscribe', reason: 'key_changed' }
    : { kind: 'none' };
}
