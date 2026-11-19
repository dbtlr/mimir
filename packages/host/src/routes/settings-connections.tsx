import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { t3StatusQuery } from '../api/t3-queries';
import { OfflineBanner } from '../components/offline-banner';
import { SettingsPage } from '../components/settings-page';
import { T3_OUTCOME_TEXT, T3Card } from '../components/t3-card';
import { Skeleton } from '../components/ui/skeleton';
import { connectivity } from '../lib/connectivity';
import { connectionsRoute } from '../router';

/**
 * `/settings/connections` — the outside services this host connects to; today
 * T3 Code (ADR 0040, MMR-733). The T3 callback's `?t3=` outcome shows once,
 * then it leaves the URL; the card holds it when T3 is configured, and this
 * page holds it otherwise (unconfigured, unreadable, or still loading). With T3
 * unconfigured the page says so instead of rendering nothing.
 */
export function ConnectionsPage() {
  const status = useQuery(t3StatusQuery);
  const conn = connectivity([status]);
  const { t3 } = connectionsRoute.useSearch();
  const navigate = connectionsRoute.useNavigate();
  const [t3Outcome] = useState(t3);
  useEffect(() => {
    if (t3 !== undefined) {
      void navigate({ replace: true, search: {} });
    }
  }, [navigate, t3]);
  const state = status.data?.state;
  const cardShown = state !== undefined && state !== 'unconfigured';

  return (
    <>
      <OfflineBanner {...conn} />
      <SettingsPage title="Connections">
        {!cardShown && t3Outcome !== undefined && (
          <p role="status" className="text-xs text-ink-bright">
            {T3_OUTCOME_TEXT[t3Outcome]}
          </p>
        )}
        {status.isPending && <Skeleton className="h-24" />}
        {state === 'unconfigured' && (
          <p className="text-xs text-ink-dim">No connections are set up on this host.</p>
        )}
        {status.isError && (
          <p className="text-xs text-ink-dim">The host did not answer, so T3 Code is unknown.</p>
        )}
        <T3Card outcome={t3Outcome} />
      </SettingsPage>
    </>
  );
}
