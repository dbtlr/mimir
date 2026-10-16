import { usePwaUpdate } from './pwa-update-provider';
import { ActionButton } from './ui/action-button';

export function PwaUpdateBanner() {
  const update = usePwaUpdate();
  if (update.phase === 'idle') {
    return null;
  }

  return (
    <div
      aria-live="polite"
      role="status"
      className="z-20 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-action/30 bg-action/10 px-3 py-2 text-xs font-semibold text-ink"
    >
      <span>{update.message}</span>
      <ActionButton
        size="sm"
        variant="outline"
        disabled={update.phase === 'applying'}
        onClick={() => void update.refreshNow()}
      >
        {update.phase === 'applying' ? 'Refreshing…' : 'Refresh now'}
      </ActionButton>
      {update.error !== null && <span className="basis-full text-center">{update.error}</span>}
    </div>
  );
}
