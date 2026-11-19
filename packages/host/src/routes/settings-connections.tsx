import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { t3StatusQuery } from '../api/t3-queries';
import { SettingsPage } from '../components/settings-page';
import { T3Card } from '../components/t3-card';
import { Skeleton } from '../components/ui/skeleton';
import { connectionsRoute } from '../router';

/**
 * `/settings/connections` — the outside services this host connects to; today
 * T3 Code (ADR 0040, MMR-733). The card shows the T3 callback's `?t3=` outcome
 * once, then it leaves the URL. With T3 unconfigured the page says so instead
 * of rendering nothing.
 */
export function ConnectionsPage() {
  const status = useQuery(t3StatusQuery);
  const { t3 } = connectionsRoute.useSearch();
  const navigate = connectionsRoute.useNavigate();
  const [t3Outcome] = useState(t3);
  useEffect(() => {
    if (t3 !== undefined) {
      void navigate({ replace: true, search: {} });
    }
  }, [navigate, t3]);

  return (
    <SettingsPage title="Connections">
      {status.isPending && <Skeleton className="h-24" />}
      {status.data?.state === 'unconfigured' && (
        <p className="text-xs text-ink-dim">No connections are set up on this host.</p>
      )}
      <T3Card outcome={t3Outcome} />
    </SettingsPage>
  );
}
