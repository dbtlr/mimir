import { useEffect, useState } from 'react';

import { cn } from '../lib/cn';
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

/** Compact manual discovery/refresh affordance for the installed console. */
export function PwaRefreshAction() {
  const standalone = useStandalone();
  const update = usePwaUpdate();
  if (!standalone) {
    return null;
  }

  const ready = update.available;
  let label = 'Refresh console';
  if (update.checking) {
    label = 'Checking for updates';
  } else if (update.phase === 'error') {
    label = 'Update failed — retry';
  } else if (ready) {
    label = 'Update ready — refresh console';
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={update.phase === 'applying'}
      onClick={() => void (ready ? update.refreshNow() : update.checkForUpdate())}
      className={cn(
        'relative flex size-[42px] shrink-0 items-center justify-center rounded-full text-ink-dim transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50',
        ready
          ? 'bg-action/15 text-action inset-ring inset-ring-action/30 hover:bg-action/20'
          : 'hover:bg-line/50 hover:text-ink-bright',
      )}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cn(update.checking && 'animate-spin')}
      >
        <path
          d="M20 7v5h-5M4 17v-5h5M6.1 8.2A7 7 0 0 1 18.7 7M17.9 15.8A7 7 0 0 1 5.3 17"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {ready && (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-2 rounded-full bg-action ring-2 ring-well-900"
        />
      )}
    </button>
  );
}
