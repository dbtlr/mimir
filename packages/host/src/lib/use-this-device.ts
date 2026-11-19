import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import type { BrowserSubscription } from './push-browser';
import { deriveThisDevice } from './push-this-device';
import { usePushBrowser } from './use-push-browser';

/**
 * This browser's notification state (ADR 0045, MMR-711), live: the host's
 * status and device list, and what the browser holds. `refresh` rereads the
 * browser after an action changed it; `retryDevices` rereads a list that
 * failed to load. `subscriptionPending` holds until the newest read of the
 * browser's subscription settles.
 */
export function useThisDevice() {
  const browser = usePushBrowser();
  const status = useQuery(pushStatusQuery);
  const devices = useQuery(pushDevicesQuery);
  const [revision, setRevision] = useState(0);
  // A new device list may follow a heal that replaced the subscription.
  const listedAt = devices.dataUpdatedAt;
  /** Which read the subscription answers: a newer one is in flight until they match. */
  const readKey = `${String(revision)}:${String(listedAt)}`;
  const [read, setRead] = useState<{ key: string; subscription: BrowserSubscription | null }>();
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
        setRead({ key: readKey, subscription: held });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [browser, readKey]);
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
    /** The browser's subscription is being read, first or again after a change: who is who in the list is not settled. */
    subscriptionPending: read?.key !== readKey,
  };
}
