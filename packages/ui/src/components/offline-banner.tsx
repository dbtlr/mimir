import type { Connectivity } from '../lib/connectivity';
import { ago } from '../lib/time';

/**
 * The offline read, loudly marked (ADR 0013 §5): a persistent banner naming
 * the one unreachable state and the last-sync time. Renders nothing while
 * the server answers.
 */
export function OfflineBanner({ offline, lastSync }: Connectivity) {
  if (!offline) {
    return null;
  }
  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex items-center justify-center gap-2 border-b border-status-blocked/40 bg-status-blocked/15 px-3 py-1.5 text-xs font-semibold text-status-blocked-foreground backdrop-blur"
    >
      <span aria-hidden className="inline-block size-[7px] rounded-full bg-status-blocked" />
      Offline — last synced{' '}
      <span className="font-mono">{lastSync === null ? 'never' : ago(lastSync)}</span>
    </div>
  );
}
