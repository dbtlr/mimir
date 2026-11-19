import { useEffect, useState } from 'react';

import { usePwaUpdate } from './pwa-update-provider';

const STANDALONE_QUERY = '(display-mode: standalone)';

function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(
    () => globalThis.matchMedia(STANDALONE_QUERY).matches,
  );
  useEffect(() => {
    const media = globalThis.matchMedia(STANDALONE_QUERY);
    const change = () => setStandalone(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return standalone;
}

/** The manual refresh's state, shared by the top bar's "…" menu and the About page. */
export type PwaRefresh = {
  /** False outside the installed console: there is nothing to offer. */
  shown: boolean;
  /** An update is waiting; acting applies it. */
  ready: boolean;
  checking: boolean;
  disabled: boolean;
  label: string;
  /** Applies a waiting update, or checks for one. */
  handleRefresh: () => void;
};

export function usePwaRefresh(): PwaRefresh {
  const standalone = useStandalone();
  const update = usePwaUpdate();
  const ready = update.available;
  let label = 'Refresh console';
  if (update.checking) {
    label = 'Checking for updates';
  } else if (update.phase === 'error') {
    label = 'Update failed — retry';
  } else if (ready) {
    label = 'Update ready — refresh console';
  }
  return {
    checking: update.checking,
    disabled: update.phase === 'applying',
    handleRefresh: () => void (ready ? update.refreshNow() : update.checkForUpdate()),
    label,
    ready,
    shown: standalone,
  };
}

/** The dot that marks a waiting update on whichever control offers it. */
export function UpdateReadyDot() {
  return (
    <span
      aria-hidden
      className="absolute top-1.5 right-1.5 size-2 rounded-full bg-action ring-2 ring-well-950"
    />
  );
}
