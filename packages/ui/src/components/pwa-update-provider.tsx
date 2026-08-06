import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { pwaRegistration } from '../lib/pwa-registration';
import type { PwaUpdateController, PwaUpdateSnapshot } from '../lib/pwa-update';

type PwaUpdateContextValue = {
  checkForUpdate: () => Promise<void>;
  refreshNow: () => Promise<void>;
} & PwaUpdateSnapshot;

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null);

export function PwaUpdateProvider({
  children,
  controller = pwaRegistration.controller,
}: {
  children: ReactNode;
  controller?: PwaUpdateController;
}) {
  useEffect(() => {
    if (controller === pwaRegistration.controller) {
      pwaRegistration.start();
      return () => pwaRegistration.stop();
    }
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const value = useMemo(
    () => ({
      ...snapshot,
      checkForUpdate: controller.checkForUpdate,
      refreshNow: controller.refreshNow,
    }),
    [controller, snapshot],
  );
  return <PwaUpdateContext.Provider value={value}>{children}</PwaUpdateContext.Provider>;
}

export function usePwaUpdate(): PwaUpdateContextValue {
  const value = useContext(PwaUpdateContext);
  if (value === null) {
    throw new Error('usePwaUpdate must be used inside PwaUpdateProvider');
  }
  return value;
}
