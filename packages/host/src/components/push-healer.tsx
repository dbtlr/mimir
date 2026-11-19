import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import type { PushDeviceList } from '../api/fns/push';
import { pushDevicesQuery, pushStatusQuery } from '../api/push-queries';
import { healThisBrowser } from '../lib/push-actions';
import { healApplies } from '../lib/push-heal';
import { usePushBrowser } from '../lib/use-push-browser';

/**
 * Heals this browser's push subscription once per console load (ADR 0045,
 * MMR-711). It reads nothing from the host until the browser itself says it
 * turned notifications on and still may, so a console that never did costs no
 * request. Renders nothing.
 */
export function PushHealer() {
  const browser = usePushBrowser();
  const snapshot = browser.snapshot();
  const record = browser.readRecord();
  const wanted =
    snapshot.pushSupported && snapshot.permission === 'granted' && record?.state === 'on';
  const status = useQuery({ ...pushStatusQuery, enabled: wanted });
  const devices = useQuery({ ...pushDevicesQuery, enabled: wanted });
  const done = useRef(false);
  useEffect(() => {
    if (
      done.current ||
      status.data === undefined ||
      devices.data === undefined ||
      !healApplies({
        permission: snapshot.permission,
        pushSupported: snapshot.pushSupported,
        record,
        status: status.data,
      })
    ) {
      return;
    }
    done.current = true;
    const heal = async (list: PushDeviceList) => {
      await healThisBrowser(browser, status.data, list);
      await devices.refetch();
    };
    void heal(devices.data);
  }, [browser, devices, record, snapshot.permission, snapshot.pushSupported, status.data]);
  return null;
}
