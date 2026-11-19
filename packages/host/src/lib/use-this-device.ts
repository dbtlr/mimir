import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import type { BrowserSubscription } from './push-browser';
import { deriveThisDevice } from './push-this-device';
import { usePushBrowser } from './use-push-browser';

/**
 * This browser's notification state (ADR 0045, MMR-711), live: the host's
 * status and device list, and what the browser holds. `refresh` rereads the
 * browser after an action changed it.
 */
export function useThisDevice() {
  const browser = usePushBrowser();
  const status = useQuery(pushStatusQuery);
  const devices = useQuery(pushDevicesQuery);
  const [subscription, setSubscription] = useState<BrowserSubscription | null | undefined>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setRevision((count) => count + 1);
  }, []);
  // A new device list may follow a heal that replaced the subscription.
  const listedAt = devices.dataUpdatedAt;
  useEffect(() => {
    let live = true;
    const read = async () => {
      let held: BrowserSubscription | null = null;
      try {
        held = await browser.subscription();
      } catch {
        // A browser that cannot say holds none for the page's purposes.
      }
      if (live) {
        setSubscription(held);
      }
    };
    void read();
    return () => {
      live = false;
    };
    // `revision` and `listedAt` are not read: each says the browser may have changed.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [browser, revision, listedAt]);
  const snapshot = browser.snapshot();
  const state = deriveThisDevice({
    browser: snapshot,
    devices: devices.data,
    record: browser.readRecord(),
    status: status.data,
    subscription,
  });
  return {
    browser,
    devices: devices.data,
    identity: snapshot.identity,
    refresh,
    state,
    status: status.data,
    subscription,
  };
}
