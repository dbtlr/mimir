import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import type { PushDeviceList } from '../api/fns/push';
import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import type { BrowserSubscription } from './push-browser';
import { deriveThisDevice } from './push-this-device';
import { usePushBrowser } from './use-push-browser';

/**
 * Which browsers the list names: its endpoints, sorted, so a poll or a saved
 * kind that leaves them as they were names the same ones; a list that is not
 * `listed` falls back to its read time.
 */
function listedEndpoints(list: PushDeviceList | undefined, updatedAt: number): string {
  if (list?.state !== 'listed') {
    return `at ${String(updatedAt)}`;
  }
  return list.devices
    .map((device) => device.endpoint)
    .toSorted()
    .join(' ');
}

/**
 * This browser's notification state (ADR 0045, MMR-711), live: the host's
 * status and device list, and what the browser holds. `refresh` rereads the
 * browser after an action changed it; `retryDevices` rereads a list that
 * failed to load. Every list read rereads the browser's subscription, so a
 * read that failed or a heal that restored it shows at the next poll.
 * `subscriptionPending` holds only while a read is in flight for an action or
 * for a list naming other endpoints than the settled read's; a poll naming the
 * same ones rereads quietly, showing the settled subscription meanwhile.
 */
export function useThisDevice() {
  const browser = usePushBrowser();
  const status = useQuery(pushStatusQuery);
  const devices = useQuery(pushDevicesQuery);
  const [revision, setRevision] = useState(0);
  /** Which read is the newest: every list read, and every action, starts one. */
  const readKey = `${String(revision)}:${String(devices.dataUpdatedAt)}`;
  /** Who is who in the list: only an action, or a list naming other endpoints, can change it. */
  const scope = `${String(revision)}:${listedEndpoints(devices.data, devices.dataUpdatedAt)}`;
  /** The settled read: the read it answers, the scope it started in, and what the browser held. */
  const [read, setRead] = useState<{
    key: string;
    scope: string;
    subscription: BrowserSubscription | null;
  }>();
  const subscription = read?.subscription;
  const refresh = useCallback(() => {
    setRevision((count) => count + 1);
  }, []);
  useEffect(() => {
    let live = true;
    const load = async () => {
      let held: BrowserSubscription | null = null;
      try {
        held = await browser.subscription();
      } catch {
        // A browser that cannot say, or whose service worker has not started, holds none for the page's purposes.
      }
      if (live) {
        setRead({ key: readKey, scope, subscription: held });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [browser, readKey, scope]);
  const snapshot = browser.snapshot();
  const state = deriveThisDevice({
    browser: snapshot,
    devices: devices.data,
    record: browser.readRecord(),
    status: status.data,
    subscription,
  });
  const { refetch: refetchDevices } = devices;
  const retryDevices = useCallback(() => {
    void refetchDevices();
  }, [refetchDevices]);
  return {
    browser,
    devices: devices.data,
    /** The device list failed to load, holds nothing to show, and is not reading again. */
    devicesFailed: devices.isError && !devices.isFetching && devices.data === undefined,
    identity: snapshot.identity,
    refresh,
    retryDevices,
    state,
    status: status.data,
    subscription,
    /** The browser's subscription is being read, first or again after an action or for other endpoints: who is who in the list is not settled. */
    subscriptionPending: read?.scope !== scope,
  };
}
