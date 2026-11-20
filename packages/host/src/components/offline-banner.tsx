import type { Connectivity } from '../lib/connectivity';
import { ago } from '../lib/time';
import { NoticeBanner } from './patterns/notice-banner';

/**
 * The offline read, loudly marked (ADR 0013 §5): a persistent Notice banner
 * naming the one unreachable state and the last-sync time. Renders nothing
 * while the server answers.
 */
export function OfflineBanner({ offline, lastSync }: Connectivity) {
  if (!offline) {
    return null;
  }
  return (
    <NoticeBanner tone="blocked" className="sticky top-0 z-30 gap-2 py-1.5 backdrop-blur">
      <span aria-hidden className="mr-2 inline-block size-[7px] rounded-full bg-status-blocked" />
      Offline — last synced{' '}
      <span className="font-mono">{lastSync === null ? 'never' : ago(lastSync)}</span>
    </NoticeBanner>
  );
}
