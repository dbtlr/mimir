import { NoticeBanner } from './patterns/notice-banner';
import { usePwaUpdate } from './pwa-update-provider';

/** A Notice banner for a waiting update (ADR 0019, MMR-736), with its Refresh action. */
export function PwaUpdateBanner() {
  const update = usePwaUpdate();
  if (update.phase === 'idle') {
    return null;
  }

  return (
    <NoticeBanner
      className="z-20"
      action={{
        disabled: update.phase === 'applying',
        label: update.phase === 'applying' ? 'Refreshing…' : 'Refresh now',
        onClick: () => void update.refreshNow(),
      }}
      detail={update.error ?? undefined}
    >
      {update.message}
    </NoticeBanner>
  );
}
