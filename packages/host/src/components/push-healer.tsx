import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import { healThisBrowser } from '../lib/push-actions';
import { usePushBrowser } from '../lib/use-push-browser';

/**
 * Heals this browser's push subscription once per console load (ADR 0045,
 * MMR-711). Whether there is anything to look at is read once, at mount: the
 * browser turned notifications on and still may. If not, it is done and asks
 * the host nothing. If so, it evaluates the first time the status and the
 * device list have both loaded, healing or not, and never acts again in this
 * load, so a record written later (a Turn on) or a re-render cannot act on a
 * stale list. Renders nothing.
 */
export function PushHealer() {
  const browser = usePushBrowser();
  const [wanted] = useState(() => {
    const snapshot = browser.snapshot();
    return (
      snapshot.pushSupported &&
      snapshot.permission === 'granted' &&
      browser.readRecord()?.state === 'on'
    );
  });
  const status = useQuery({ ...pushStatusQuery, enabled: wanted });
  const devices = useQuery({ ...pushDevicesQuery, enabled: wanted });
  const latched = useRef(false);
  const served = status.data;
  const listed = devices.data;
  const { refetch } = devices;
  useEffect(() => {
    if (latched.current) {
      return;
    }
    if (!wanted) {
      latched.current = true;
      return;
    }
    if (served === undefined || listed === undefined) {
      return;
    }
    latched.current = true;
    const heal = async () => {
      await healThisBrowser(browser, served, listed);
      await refetch();
    };
    void heal();
  }, [browser, listed, refetch, served, wanted]);
  return null;
}
