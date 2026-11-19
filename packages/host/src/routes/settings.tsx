import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { pairedDevicesQuery, pendingPairingsQuery } from '../api/device-queries';
import { t3StatusQuery } from '../api/t3-queries';
import { SETTINGS_CARD, SettingsGroup, SettingsPage } from '../components/settings-page';
import { BUILD_VERSION } from '../lib/build-version';
import { cn } from '../lib/cn';
import { notificationsValue } from '../lib/push-this-device';
import { connectionValue, devicesValue, THEME_CHOICE_LABEL, versionLabel } from '../lib/settings';
import { useTheme } from '../lib/use-theme';
import { useThisDevice } from '../lib/use-this-device';

/**
 * `/settings` — the index (ADR 0013, MMR-733): one row per settings page, in
 * "This device" and "Host", each showing how that page is set now. A pairing
 * request waiting on the operator shows in the attention color. On a desktop
 * the sidebar lists the same pages beside it.
 */

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SettingsGroup title={title}>
      <ul className={SETTINGS_CARD}>{children}</ul>
    </SettingsGroup>
  );
}

function Row({
  to,
  name,
  value,
  tone,
}: {
  to:
    | '/settings/notifications'
    | '/settings/appearance'
    | '/settings/devices'
    | '/settings/connections'
    | '/settings/about';
  name: string;
  value: string;
  tone?: 'attention' | 'ok';
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-meta text-ink-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span>{name}</span>
        <span
          className={cn(
            'ml-auto min-w-0 truncate text-ink-dim',
            tone === 'attention' && 'font-semibold text-attention-foreground',
            tone === 'ok' && 'text-status-done',
          )}
        >
          {value}
        </span>
        <span aria-hidden className="text-ink-faint">
          ›
        </span>
      </Link>
    </li>
  );
}

export function SettingsIndexPage() {
  const { choice } = useTheme();
  const pending = useQuery(pendingPairingsQuery);
  const paired = useQuery(pairedDevicesQuery);
  const t3 = useQuery(t3StatusQuery);
  const devices = devicesValue({
    paired: paired.data?.length ?? 0,
    waiting: pending.data?.length ?? 0,
  });
  const connection = connectionValue(t3.data);
  const notifications = notificationsValue(useThisDevice().state);
  return (
    <SettingsPage title="Settings" back={false}>
      <Group title="This device">
        <Row to="/settings/notifications" name="Notifications" value={notifications} />
        <Row to="/settings/appearance" name="Appearance" value={THEME_CHOICE_LABEL[choice]} />
      </Group>
      <Group title="Host">
        <Row
          to="/settings/devices"
          name="Devices"
          value={pending.data === undefined || paired.data === undefined ? '' : devices.text}
          tone={devices.attention ? 'attention' : undefined}
        />
        <Row
          to="/settings/connections"
          name="Connections"
          value={connection}
          tone={t3.data?.state === 'connected' ? 'ok' : undefined}
        />
        <Row to="/settings/about" name="About" value={versionLabel(BUILD_VERSION)} />
      </Group>
    </SettingsPage>
  );
}
