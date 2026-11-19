import { createContext, useContext } from 'react';

import { createBrowserPushBrowser } from './push-browser';
import type { PushBrowser } from './push-browser';

/** A test, or a host page that wants another browser, supplies its own adapter here. */
export const PushBrowserContext = createContext<PushBrowser | null>(null);

let own: PushBrowser | undefined;

/** This browser's adapter, created on first use so nothing reads the browser at import. */
export function usePushBrowser(): PushBrowser {
  const supplied = useContext(PushBrowserContext);
  if (supplied !== null) {
    return supplied;
  }
  own ??= createBrowserPushBrowser();
  return own;
}
