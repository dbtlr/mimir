import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { healthQuery } from '../api/shell-queries';
import { usePwaRefresh } from '../components/pwa-refresh-action';
import { SettingsPage } from '../components/settings-page';
import { ActionButton } from '../components/ui/action-button';
import { BUILD_VERSION } from '../lib/build-version';
import { versionLabel } from '../lib/settings';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-2.5 text-meta">
      <dt className="text-ink-dim">{label}</dt>
      <dd className="ml-auto font-mono text-ink-bright">{children}</dd>
    </div>
  );
}

/**
 * `/settings/about` — the host and console versions, the update check when the
 * console runs installed, and the way to Record health (MMR-733).
 */
export function AboutPage() {
  const health = useQuery(healthQuery);
  const refresh = usePwaRefresh();
  const hostVersion = health.data?.version;
  return (
    <SettingsPage title="About">
      <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-well-850">
        <Fact label="Host">
          {hostVersion === undefined ? 'Unknown' : versionLabel(hostVersion)}
        </Fact>
        <Fact label="Console">{versionLabel(BUILD_VERSION)}</Fact>
      </dl>
      {refresh.shown && (
        <div>
          <ActionButton
            size="sm"
            variant="outline"
            disabled={refresh.disabled}
            onClick={refresh.handleRefresh}
          >
            {refresh.label}
          </ActionButton>
        </div>
      )}
      <Link
        to="/doctor"
        className="w-fit rounded text-xs text-ink-dim hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
      >
        Record health →
      </Link>
    </SettingsPage>
  );
}
